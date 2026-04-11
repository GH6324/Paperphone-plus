use web_push::WebPushClient;
use crate::config::Config;

/// Send Web Push notification to a user via VAPID
pub async fn push_to_user(db: &sqlx::MySqlPool, config: &Config, user_id: &str, title: &str, body: &str) {
    let (_public_key, private_key, _subject) = match (&config.vapid_public_key, &config.vapid_private_key, &config.vapid_subject) {
        (Some(pub_k), Some(priv_k), Some(subj)) => (pub_k.clone(), priv_k.clone(), subj.clone()),
        _ => return, // VAPID not configured
    };

    let subs: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
    )
    .bind(user_id)
    .fetch_all(db).await.unwrap_or_default();

    if subs.is_empty() { return; }

    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "data": { "type": "message" }
    });
    let payload_str = serde_json::to_string(&payload).unwrap_or_default();

    for (endpoint, p256dh, auth) in &subs {
        let sub = web_push::SubscriptionInfo {
            endpoint: endpoint.clone(),
            keys: web_push::SubscriptionKeys {
                p256dh: p256dh.clone(),
                auth: auth.clone(),
            },
        };

        // Use from_base64 which takes SubscriptionInfo directly and returns full VapidSignatureBuilder
        let signature = match web_push::VapidSignatureBuilder::from_base64(
            &private_key,
            web_push::URL_SAFE_NO_PAD,
            &sub,
        ) {
            Ok(mut b) => match b.build() {
                Ok(sig) => sig,
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        let mut builder = web_push::WebPushMessageBuilder::new(&sub);
        builder.set_payload(web_push::ContentEncoding::Aes128Gcm, payload_str.as_bytes());
        builder.set_vapid_signature(signature);

        if let Ok(message) = builder.build() {
            if let Ok(client) = web_push::IsahcWebPushClient::new() {
                let _ = client.send(message).await;
            }
        }
    }
}
