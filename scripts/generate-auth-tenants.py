#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["bcrypt>=4.1"]
# ///
"""Generate the corporate-login tenants for the demo.

Outputs (all committed; rerun this script to regenerate, output is deterministic):
  src/postgres/auth-seed.sql                                  companies + users for the auth schema
  src/load-generator/corporate_users.json                     who the load generator logs in as
  skaffold-config/charts/otel-services/files/auth-host-aliases.yaml
                                                              hostAliases for the auth pod

Usage: scripts/generate-auth-tenants.py
"""

import base64
import json
import random
from pathlib import Path

import bcrypt

SEED = 20260927
DEMO_PASSWORD = "stargazer-2026"
BCRYPT_COST = 10

IDP_HOST = "sso.keystone-id.example"
MOCK_ADDR = "127.0.0.1"
UNREACHABLE_ADDR = "192.0.2.1"

ROOT = Path(__file__).resolve().parent.parent

GLOBEX = ("globex", "Globex Corporation")

COMPANIES = [
    "Initech", "Umbrella Freight", "Vandelay Imports", "Wonka Industries", "Stark Logistics",
    "Soylent Foods", "Cyberdyne Analytics", "Tyrell Biotech", "Wayne Shipping", "Oscorp Labs",
    "Dunder Paper", "Hooli Cloud", "Pied Piper", "Gringotts Lending", "Monarch Solutions",
    "Aperture Science", "Black Mesa Research", "Massive Dynamic", "Nakatomi Trading", "Virtucon",
    "Bluth Homes", "Prestige Worldwide", "Sterling Cooper", "Wernham Hogg", "Krusty Foods",
    "Blue Sun Mining", "Weyland Dynamics", "Ollivander Supply", "Duff Brewing", "Planet Express",
    "Spacely Sprockets", "Cogswell Cogs", "Rekall Travel", "Omni Consumer Products", "Buy n Large",
    "Gekko Partners", "Strickland Propane", "Los Pollos Supply", "Kramerica",
]
N_SSO = 23  # of the 39 non-Globex tenants; the rest use passwords

FIRST = [
    "Ada", "Alan", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Frances", "Edsger",
    "Radia", "Donald", "Hedy", "Tim", "Katherine", "John", "Sophie", "Guido", "Anita", "Bjarne",
    "Karen", "Whitfield", "Evelyn", "Vint", "Joan", "Leslie", "Mary", "Niklaus", "Shafi", "Yukihiro",
    "Rosa", "Omar", "Priya", "Mateo", "Aisha", "Chen", "Ingrid", "Kwame", "Lena", "Rafael",
    "Sana", "Tomas", "Uma", "Viktor", "Wen", "Ximena", "Yara", "Zane", "Nadia", "Pavel",
]
LAST = [
    "Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson", "Allen",
    "Dijkstra", "Perlman", "Knuth", "Lamarr", "Berners-Lee", "Johnson", "McCarthy", "Wilson",
    "Rossum", "Borg", "Stroustrup", "Jones", "Diffie", "Boyd", "Cerf", "Clarke", "Lamport", "Kenneth",
    "Wirth", "Goldwasser", "Matsumoto", "Okafor", "Haddad", "Raman", "Silva", "Bello", "Zhang",
    "Larsen", "Mensah", "Fischer", "Ortega", "Kaur", "Novak", "Iyer", "Petrov", "Liu", "Reyes",
    "Nasser", "Walsh", "Kowalski", "Sato",
]

BCRYPT_ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def deterministic_salt(rng: random.Random) -> bytes:
    # bcrypt's own gensalt() reads os.urandom; derive the salt from our RNG so reruns are stable.
    body = "".join(rng.choice(BCRYPT_ALPHABET) for _ in range(21)) + rng.choice(".Oeu")
    return f"$2b${BCRYPT_COST:02d}${body}".encode()


def user_id(rng: random.Random) -> str:
    return "usr_" + base64.b32encode(rng.randbytes(10)).decode().lower()


def make_users(rng, company_id, domain, count, method):
    users, seen = [], set()
    while len(users) < count:
        first, last = rng.choice(FIRST), rng.choice(LAST)
        local = f"{first}.{last}".lower().replace("-", "")
        if local in seen:
            local = f"{local}{rng.randint(2, 99)}"
            if local in seen:
                continue
        seen.add(local)
        pw_hash = None
        if method == "password":
            pw_hash = bcrypt.hashpw(DEMO_PASSWORD.encode(), deterministic_salt(rng)).decode()
        users.append({
            "corporate_user_id": user_id(rng),
            "company_id": company_id,
            "email": f"{local}@{domain}",
            "display_name": f"{first} {last}",
            "password_hash": pw_hash,
        })
    return users


def sql_str(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    rng = random.Random(SEED)

    others = COMPANIES[:]
    rng.shuffle(others)
    companies = [{"company_id": GLOBEX[0], "name": GLOBEX[1], "login_method": "sso", "users": 200}]
    for i, name in enumerate(others):
        companies.append({
            "company_id": slugify(name),
            "name": name,
            "login_method": "sso" if i < N_SSO else "password",
            "users": rng.randint(10, 40),
        })
    for c in companies:
        c["domain"] = f"{c['company_id']}.example"
        c["idp_tenant"] = f"{c['company_id']}-{rng.randbytes(3).hex()}" if c["login_method"] == "sso" else None

    all_users = []
    for c in companies:
        all_users += make_users(rng, c["company_id"], c["domain"], c["users"], c["login_method"])

    # --- auth-seed.sql
    lines = [
        "-- Generated by scripts/generate-auth-tenants.py. Do not edit by hand.",
        "",
        "INSERT INTO auth.company (company_id, name, domain, login_method, idp_tenant) VALUES",
        ",\n".join(
            f"    ({sql_str(c['company_id'])}, {sql_str(c['name'])}, {sql_str(c['domain'])}, "
            f"{sql_str(c['login_method'])}, {sql_str(c['idp_tenant'])})"
            for c in companies
        ) + ";",
        "",
        "INSERT INTO auth.corporate_user (corporate_user_id, company_id, email, display_name, password_hash) VALUES",
        ",\n".join(
            f"    ({sql_str(u['corporate_user_id'])}, {sql_str(u['company_id'])}, {sql_str(u['email'])}, "
            f"{sql_str(u['display_name'])}, {sql_str(u['password_hash'])})"
            for u in all_users
        ) + ";",
        "",
    ]
    (ROOT / "src/postgres/auth-seed.sql").write_text("\n".join(lines))

    # --- corporate_users.json (for the load generator)
    method_of = {c["company_id"]: c["login_method"] for c in companies}
    loadgen = [
        {
            "email": u["email"],
            "company": u["company_id"],
            "method": method_of[u["company_id"]],
            "password": DEMO_PASSWORD if method_of[u["company_id"]] == "password" else None,
        }
        for u in all_users
    ]
    (ROOT / "src/load-generator/corporate_users.json").write_text(json.dumps(loadgen, indent=1) + "\n")

    # --- hostAliases for the auth pod
    tenant_status_hosts = [
        f"sso-status.{c['domain']}"
        for c in companies
        if c["login_method"] == "sso" and c["company_id"] != GLOBEX[0]
    ]
    alias_lines = [
        "# Generated by scripts/generate-auth-tenants.py. Do not edit by hand.",
        "- ip: " + MOCK_ADDR,
        "  hostnames:",
        f"    - {IDP_HOST}",
        f"    - sso-status.{GLOBEX[0]}.example",
        "# tenant-hosted endpoints; not reachable from the demo cluster",
        "- ip: " + UNREACHABLE_ADDR,
        "  hostnames:",
        *[f"    - {h}" for h in tenant_status_hosts],
        "",
    ]
    out = ROOT / "skaffold-config/charts/otel-services/files/auth-host-aliases.yaml"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(alias_lines))

    sso = sum(1 for c in companies if c["login_method"] == "sso")
    print(f"{len(companies)} companies ({sso} sso, {len(companies) - sso} password), {len(all_users)} users")


if __name__ == "__main__":
    main()
