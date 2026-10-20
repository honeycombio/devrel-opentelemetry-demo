#!/usr/bin/env python3
"""Generate the returning customers and their promo-code history for the demo.

Outputs (all committed; rerun this script to regenerate, output is deterministic):
  src/postgres/promo-seed.sql                   promo codes + who was issued which, for the promotions schema
  src/load-generator/returning_customers.json   who the load generator checks out as, and their current codes

Promo codes come from two systems:
  legacy-newsletter (2015-2019)  marketing typed codes in by hand, so anything went:
                                 spaces, punctuation, accents ('SUMMER-20%', "XMAS'18", 'CAFÉ15')
  promo-engine (2020 onwards)    generated codes, always [A-Z0-9]

Customers who have been with us since before 2020 still carry their legacy codes in
their history. Nothing reads those old rows today; checkout only looks at the code entered.

Usage: scripts/generate-promo-seed.py
"""

import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SEED = 20261020
N_CUSTOMERS = 300
FIRST_YEAR = 2015
ENGINE_YEAR = 2020  # promo-engine replaced the newsletter tool
THIS_YEAR = 2026

ROOT = Path(__file__).resolve().parent.parent

# (code, campaign, year, percent_off)
LEGACY_CODES = [
    ("WELCOME5", "welcome", 2015, 5),
    ("WELCOME 5", "welcome", 2015, 5),
    ("SPRING*15", "spring-sale", 2015, 15),
    ("SUMMER-20%", "summer-sale", 2016, 20),
    ("BACK2SCHOOL/16", "back-to-school", 2016, 10),
    ("XMAS'16", "christmas", 2016, 15),
    ("STARGAZER10", "newsletter-signup", 2017, 10),
    ("FRIENDS&FAMILY", "friends-and-family", 2017, 20),
    ("10%OFF", "newsletter-signup", 2017, 10),
    ("BLACK FRIDAY!", "black-friday", 2017, 25),
    ("XMAS'18", "christmas", 2018, 15),
    ("CAFÉ15", "partner-cafe", 2018, 15),
    ("NEWYEAR#2018", "new-year", 2018, 10),
    ("SUMMER-25%", "summer-sale", 2018, 25),
    ("MOONWALK19", "apollo-anniversary", 2019, 19),
    ("VALENTINE<3", "valentines", 2019, 10),
    ("SPRING_19", "spring-sale", 2019, 15),
    ("THANKS:)", "customer-thanks", 2019, 5),
    ("CYBER-MONDAY", "cyber-monday", 2019, 20),
]

# Codes still valid now. Every customer holds at least one, unredeemed.
CURRENT_CODES = [
    ("THANKYOU10", "customer-thanks", THIS_YEAR, 10),
    ("COMEBACK15", "win-back", THIS_YEAR, 15),
    ("STARGAZE20", "autumn-sale", THIS_YEAR, 20),
]

FIRST = [
    "Ada", "Alan", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Frances", "Edsger",
    "Radia", "Donald", "Hedy", "Tim", "Katherine", "John", "Sophie", "Guido", "Anita", "Bjarne",
    "Rosa", "Omar", "Priya", "Mateo", "Aisha", "Chen", "Ingrid", "Kwame", "Lena", "Rafael",
]
LAST = [
    "Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson",
    "Dijkstra", "Perlman", "Knuth", "Lamarr", "Johnson", "McCarthy", "Wilson", "Cerf", "Clarke",
    "Okafor", "Haddad", "Raman", "Silva", "Bello", "Zhang", "Larsen", "Mensah", "Fischer", "Ortega",
]
MAIL_DOMAINS = ["mail.example", "inbox.example", "post.example"]


def engine_codes():
    out = []
    for year in range(ENGINE_YEAR, THIS_YEAR):
        yy = f"{year % 100:02d}"
        out += [
            (f"SPRING{yy}", "spring-sale", year, 15),
            (f"SUMMER{yy}", "summer-sale", year, 20),
            (f"BFRIDAY{yy}", "black-friday", year, 25),
            (f"XMAS{yy}", "christmas", year, 15),
        ]
    out.append(("WELCOME10", "welcome", ENGINE_YEAR, 10))
    return out


def sql_str(s):
    return "NULL" if s is None else "'" + s.replace("'", "''") + "'"


def random_instant(rng, year, not_before=None):
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    if not_before and not_before > start:
        start = not_before
    end = min(datetime(year, 12, 31, 23, 59, tzinfo=timezone.utc), datetime(THIS_YEAR, 10, 1, tzinfo=timezone.utc))
    if end <= start:
        return start
    return start + timedelta(seconds=rng.randint(0, int((end - start).total_seconds())))


def main():
    rng = random.Random(SEED)
    engine = engine_codes()
    all_codes = LEGACY_CODES + engine + CURRENT_CODES

    customers = []
    issued = []  # (email, code, issued_at, redeemed_at)
    seen_emails = set()
    while len(customers) < N_CUSTOMERS:
        first, last = rng.choice(FIRST), rng.choice(LAST)
        email = f"{first}.{last}{rng.randint(1, 99)}@{rng.choice(MAIL_DOMAINS)}".lower()
        if email in seen_emails:
            continue
        seen_emails.add(email)
        # About 40% of returning customers have been around since the newsletter days.
        since = rng.randint(FIRST_YEAR, ENGINE_YEAR - 1) if rng.random() < 0.4 else rng.randint(ENGINE_YEAR, THIS_YEAR)
        joined = random_instant(rng, since)

        history = []
        for year in range(since, THIS_YEAR):
            pool = [c for c in (LEGACY_CODES if year < ENGINE_YEAR else engine) if c[2] == year]
            for code in rng.sample(pool, k=min(len(pool), rng.randint(1, 2))):
                issued_at = random_instant(rng, year, joined)
                redeemed_at = issued_at + timedelta(days=rng.randint(1, 60)) if rng.random() < 0.6 else None
                history.append((code[0], issued_at, redeemed_at))
        current = rng.sample(CURRENT_CODES, k=rng.randint(1, 2))
        for code in current:
            history.append((code[0], random_instant(rng, THIS_YEAR, joined), None))

        for code, issued_at, redeemed_at in history:
            issued.append((email, code, issued_at, redeemed_at))
        customers.append({
            "email": email,
            "customer_since": since,
            "current_codes": [c[0] for c in current],
        })

    lines = [
        "-- Generated by scripts/generate-promo-seed.py. Do not edit by hand.",
        "",
        "INSERT INTO promotions.promo_code (code, campaign, issued_by, percent_off, valid_from, valid_until) VALUES",
    ]
    rows = []
    for code, campaign, year, pct in all_codes:
        issued_by = "legacy-newsletter" if year < ENGINE_YEAR else "promo-engine"
        valid_until = None if year == THIS_YEAR else date(year + 1, 1, 31).isoformat()
        rows.append(f"    ({sql_str(code)}, {sql_str(campaign)}, {sql_str(issued_by)}, {pct}, "
                    f"{sql_str(date(year, 1, 1).isoformat())}, {sql_str(valid_until)})")
    lines.append(",\n".join(rows) + ";")
    lines += ["", "INSERT INTO promotions.customer_promo (email, code, issued_at, redeemed_at) VALUES"]
    rows = []
    for email, code, issued_at, redeemed_at in issued:
        rows.append(f"    ({sql_str(email)}, {sql_str(code)}, {sql_str(issued_at.isoformat())}, "
                    f"{sql_str(redeemed_at.isoformat() if redeemed_at else None)})")
    lines.append(",\n".join(rows) + ";")
    (ROOT / "src/postgres/promo-seed.sql").write_text("\n".join(lines) + "\n", encoding="utf-8")

    (ROOT / "src/load-generator/returning_customers.json").write_text(
        json.dumps(customers, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    legacy = sum(1 for c in customers if c["customer_since"] < ENGINE_YEAR)
    print(f"{len(customers)} customers ({legacy} since before {ENGINE_YEAR}), {len(issued)} issued codes")


if __name__ == "__main__":
    main()
