use std::sync::Arc;
use axum::{Router, routing::{get, post}, extract::State, Json};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Deserialize;

use crate::AppState;
use crate::auth::middleware::AuthUser;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/turn-credentials", get(get_turn_credentials))
        .route("/meeting-token", post(create_meeting_token))
}

#[derive(Deserialize)]
struct MeetingTokenRequest {
    group_id: String,
    call_id: String,
}

/// Mint a short-lived LiveKit token only for a member of this group. The group
/// owner receives room-admin capability; all other moderation is still checked
/// by our signaling server before it is broadcast.
async fn create_meeting_token(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(body): Json<MeetingTokenRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    let membership: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT g.owner_id, u.nickname, u.avatar FROM group_members gm \
         JOIN `groups` g ON g.id = gm.group_id JOIN users u ON u.id = gm.user_id \
         WHERE gm.group_id = ? AND gm.user_id = ?"
    ).bind(&body.group_id).bind(&auth.0.id).fetch_optional(&state.db).await
     .map_err(|_| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"Unable to validate meeting membership"}))))?;
    let (owner_id, nickname, avatar) = membership.ok_or_else(|| (
        axum::http::StatusCode::FORBIDDEN, Json(serde_json::json!({"error":"You are not a member of this group"}))
    ))?;

    let url = state.config.livekit_url.as_deref().filter(|v| !v.is_empty());
    let key = state.config.livekit_api_key.as_deref().filter(|v| !v.is_empty());
    let secret = state.config.livekit_api_secret.as_deref().filter(|v| !v.is_empty());
    let (url, key, secret) = match (url, key, secret) {
        (Some(url), Some(key), Some(secret)) => (url, key, secret),
        _ => return Err((axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
            "error":"Video meeting SFU is not configured (LIVEKIT_URL/API_KEY/API_SECRET)"
        }))))
    };

    let now = chrono::Utc::now().timestamp() as usize;
    let room = format!("group_{}_{}", body.group_id, body.call_id);
    let is_host = owner_id == auth.0.id;
    let claims = serde_json::json!({
        "iss": key, "sub": auth.0.id, "nbf": now.saturating_sub(5), "exp": now + 6 * 60 * 60,
        "name": nickname,
        "metadata": serde_json::json!({"avatar": avatar, "groupId": body.group_id, "host": is_host}).to_string(),
        "video": {
            "roomJoin": true, "room": room, "canPublish": true, "canSubscribe": true,
            "canPublishData": true, "roomAdmin": is_host
        }
    });
    let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|_| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"Unable to create meeting token"}))))?;
    Ok(Json(serde_json::json!({"url": url, "token": token, "room": room, "is_host": is_host, "max_participants": 100})))
}

async fn get_turn_credentials(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {

    // ── Strategy 1: Cloudflare TURN (premium, if configured) ──
    if let (Some(app_id), Some(app_secret)) = (&state.config.cf_calls_app_id, &state.config.cf_calls_app_secret) {
        if !app_id.is_empty() && !app_secret.is_empty() {
            let client = reqwest::Client::new();
            let resp = client
                .post(format!("https://rtc.live.cloudflare.com/v1/turn/keys/{}/credentials/generate", app_id))
                .bearer_auth(app_secret)
                .json(&serde_json::json!({ "ttl": 86400 }))
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let ice_servers = body.get("iceServers").cloned().unwrap_or_default();
                    if ice_servers.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        tracing::info!("[TURN] ✅ Cloudflare TURN credentials OK");
                        return Ok(Json(serde_json::json!({ "iceServers": ice_servers })));
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    tracing::warn!("[TURN] Cloudflare API error ({}): {}", status, &body[..200.min(body.len())]);
                }
                Err(e) => {
                    tracing::warn!("[TURN] Cloudflare API request failed: {:?}", e);
                }
            }
        }
    }

    // ── Strategy 2: Metered.ca TURN (free tier, if API key configured) ──
    if let Some(api_key) = &state.config.metered_turn_api_key {
        if !api_key.is_empty() {
            let client = reqwest::Client::new();
            let resp = client
                .get(format!("https://paperphoneplus.metered.live/api/v1/turn/credentials?apiKey={}", api_key))
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => {
                    let ice_servers: serde_json::Value = r.json().await.unwrap_or_default();
                    if ice_servers.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        tracing::info!("[TURN] ✅ Metered.ca TURN credentials OK");
                        return Ok(Json(serde_json::json!({ "iceServers": ice_servers })));
                    }
                }
                _ => {
                    tracing::warn!("[TURN] Metered.ca API failed");
                }
            }
        }
    }

    // ── Strategy 3: Static free TURN servers (always available fallback) ──
    tracing::info!("[TURN] Using static free TURN servers");
    Ok(Json(serde_json::json!({
        "iceServers": [
            { "urls": "stun:stun.l.google.com:19302" },
            { "urls": "stun:stun.cloudflare.com:3478" },
            {
                "urls": [
                    "turn:openrelay.metered.ca:80",
                    "turn:openrelay.metered.ca:443",
                    "turn:openrelay.metered.ca:443?transport=tcp"
                ],
                "username": "openrelayproject",
                "credential": "openrelayproject"
            }
        ]
    })))
}
