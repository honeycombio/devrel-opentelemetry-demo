// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

use actix_web::{get, post, web, HttpResponse, Responder};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

mod quote;
use quote::create_quote_from_count;

mod tracking;
use tracking::create_tracking_id;

mod shipping_types;
pub use shipping_types::*;

const NANOS_MULTIPLE: u32 = 10000000u32;

#[post("/get-quote")]
pub async fn get_quote(req: web::Json<GetQuoteRequest>) -> impl Responder {
    let itemct: u32 = req.items.iter().map(|item| item.quantity as u32).sum();

    let quote = match create_quote_from_count(itemct).await {
        Ok(q) => q,
        Err(e) => {
            return HttpResponse::InternalServerError().body(format!("Failed to get quote: {}", e));
        }
    };

    let reply = GetQuoteResponse {
        cost_usd: Some(Money {
            currency_code: "USD".into(),
            units: quote.dollars,
            nanos: quote.cents * NANOS_MULTIPLE,
        }),
    };

    info!(
        name = "SendingQuoteValue",
        quote.dollars = quote.dollars,
        quote.cents = quote.cents,
        message = "Sending Quote"
    );

    HttpResponse::Ok().json(reply)
}

#[post("/ship-order")]
pub async fn ship_order(_req: web::Json<ShipOrderRequest>) -> impl Responder {
    let tid = create_tracking_id();
    info!(
        name = "CreatingTrackingId",
        tracking_id = tid.as_str(),
        message = "Tracking ID Created"
    );
    HttpResponse::Ok().json(ShipOrderResponse { tracking_id: tid })
}

#[get("/shipping-status/{trackingId}")]
pub async fn get_shipping_status(tracking_id: web::Path<String>) -> impl Responder {
    let tracking_id = tracking_id.into_inner();
    let hash: usize = tracking_id.bytes().map(|b| b as usize).sum();

    let statuses = ["processing", "shipped", "in_transit", "delivered"];
    let status = statuses[hash % 4];

    let day_offset = (hash % 7) as u64;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + day_offset * 86400;
    let days_since_epoch = secs / 86400;
    // Civil date from days since epoch (algorithm from Howard Hinnant)
    let z = days_since_epoch as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let estimated_delivery = format!("{:04}-{:02}-{:02}", y, m, d);

    info!(
        name = "GetShippingStatus",
        tracking_id = tracking_id.as_str(),
        status = status,
        estimated_delivery = estimated_delivery.as_str(),
        message = "Shipping status retrieved"
    );

    HttpResponse::Ok().json(ShippingStatusResponse {
        tracking_id,
        status: status.to_string(),
        estimated_delivery,
    })
}

#[cfg(test)]
mod tests {
    use actix_web::{http::header::ContentType, test, App};

    use super::*;

    #[actix_web::test]
    async fn test_ship_order() {
        let app = test::init_service(App::new().service(ship_order)).await;
        let req = test::TestRequest::post()
            .uri("/ship-order")
            .insert_header(ContentType::json())
            .set_json(&ShipOrderRequest {})
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let order: ShipOrderResponse = test::read_body_json(resp).await;
        assert!(!order.tracking_id.is_empty());
    }
}
