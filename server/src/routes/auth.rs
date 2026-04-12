use std::sync::Arc;
use axum::{Router, routing::post, extract::State, Json, http::HeaderMap};
use serde::{Deserialize, Serialize};
use argon2::{Argon2, PasswordHasher, PasswordVerifier, password_hash::{SaltString, rand_core::OsRng}};
use uuid::Uuid;

use crate::AppState;
use crate::auth::jwt::{sign_token, sign_2fa_pending_token};

#[derive(Deserialize)]
pub struct RegisterReq {
    username: String,
    nickname: Option<String>,
    password: String,
    ik_pub: String,
    spk_pub: String,
    spk_sig: String,
    kem_pub: String,
    prekeys: Option<Vec<PrekeyItem>>,
}

#[derive(Deserialize)]
pub struct PrekeyItem {
    key_id: i32,
    opk_pub: String,
}

#[derive(Deserialize)]
pub struct LoginReq {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    user: UserInfo,
}

#[derive(Serialize)]
struct TwoFaResponse {
    requires_2fa: bool,
    login_token: String,
}

#[derive(Serialize)]
#[allow(dead_code)]
struct UserInfo {
    id: String,
    username: String,
    nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
}

async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RegisterReq>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), (axum::http::StatusCode, Json<serde_json::Value>)> {
    if body.username.is_empty() || body.password.is_empty() || body.ik_pub.is_empty() || body.spk_pub.is_empty() || body.spk_sig.is_empty() || body.kem_pub.is_empty() {
        return Err((axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Missing required fields" }))));
    }

    // Check existing
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))))?;

    if existing.is_some() {
        return Err((axum::http::StatusCode::CONFLICT, Json(serde_json::json!({ "error": "Username already taken" }))));
    }

    // Hash password
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(body.password.as_bytes(), &salt)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))))?
        .to_string();

    let id = Uuid::new_v4().to_string();
    let nickname = body.nickname.unwrap_or_else(|| body.username.clone());

    sqlx::query(
        "INSERT INTO users (id, username, nickname, password, ik_pub, spk_pub, spk_sig, kem_pub) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id).bind(&body.username).bind(&nickname).bind(&hash)
    .bind(&body.ik_pub).bind(&body.spk_pub).bind(&body.spk_sig).bind(&body.kem_pub)
    .execute(&state.db).await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))))?;

    // Upload prekeys
    if let Some(prekeys) = &body.prekeys {
        for pk in prekeys {
            sqlx::query("INSERT INTO prekeys (user_id, key_id, opk_pub) VALUES (?, ?, ?)")
                .bind(&id).bind(pk.key_id).bind(&pk.opk_pub)
                .execute(&state.db).await.ok();
        }
    }

    // Create session with device info
    let session_id = Uuid::new_v4().to_string();
    let (device_name, device_type, os_name, browser_name) = parse_user_agent(&headers);
    let ip_address = extract_ip(&headers);
    sqlx::query("INSERT INTO sessions (id, user_id, device_name, device_type, os, browser, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&session_id).bind(&id).bind(&device_name).bind(&device_type).bind(&os_name).bind(&browser_name).bind(&ip_address)
        .execute(&state.db).await.ok();

    let token = sign_token(&id, &body.username, Some(&session_id), &state.config.jwt_secret);

    Ok((axum::http::StatusCode::CREATED, Json(serde_json::json!({
        "token": token,
        "user": { "id": id, "username": body.username, "nickname": nickname }
    }))))
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<LoginReq>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    if body.username.is_empty() || body.password.is_empty() {
        return Err((axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Missing fields" }))));
    }

    let user: Option<(String, String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT id, username, nickname, avatar, password, ik_pub FROM users WHERE username = ?"
    )
    .bind(&body.username)
    .fetch_optional(&state.db).await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))))?;

    let (id, username, nickname, avatar, pw_hash, ik_pub) = user
        .ok_or_else(|| (axum::http::StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Invalid credentials" }))))?;

    // Verify password
    let parsed_hash = argon2::PasswordHash::new(&pw_hash)
        .map_err(|_| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Password hash error" }))))?;
    Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .map_err(|_| (axum::http::StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Invalid credentials" }))))?;

    // Check 2FA
    let totp_enabled: Option<(i8,)> = sqlx::query_as(
        "SELECT enabled FROM user_totp WHERE user_id = ? AND enabled = 1"
    )
    .bind(&id)
    .fetch_optional(&state.db).await.unwrap_or(None);

    if totp_enabled.is_some() {
        let login_token = sign_2fa_pending_token(&id, &username, &state.config.jwt_secret);
        return Ok(Json(serde_json::json!({ "requires_2fa": true, "login_token": login_token })));
    }

    // Create session with device info
    let session_id = Uuid::new_v4().to_string();
    let (device_name, device_type, os_name, browser_name) = parse_user_agent(&headers);
    let ip_address = extract_ip(&headers);
    sqlx::query("INSERT INTO sessions (id, user_id, device_name, device_type, os, browser, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&session_id).bind(&id).bind(&device_name).bind(&device_type).bind(&os_name).bind(&browser_name).bind(&ip_address)
        .execute(&state.db).await.ok();

    let token = sign_token(&id, &username, Some(&session_id), &state.config.jwt_secret);

    Ok(Json(serde_json::json!({
        "token": token,
        "user": { "id": id, "username": username, "nickname": nickname, "avatar": avatar, "ik_pub": ik_pub }
    })))
}

/// Parse User-Agent header into (device_name, device_type, os, browser)
pub fn parse_user_agent(headers: &HeaderMap) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("");

    let browser = if ua.contains("Firefox") {
        Some("Firefox".to_string())
    } else if ua.contains("Edg/") {
        Some("Edge".to_string())
    } else if ua.contains("Chrome") {
        Some("Chrome".to_string())
    } else if ua.contains("Safari") {
        Some("Safari".to_string())
    } else if !ua.is_empty() {
        Some(ua.chars().take(64).collect())
    } else {
        None
    };

    let os = if ua.contains("Windows") {
        Some("Windows".to_string())
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        Some("macOS".to_string())
    } else if ua.contains("iPhone") || ua.contains("iPad") {
        Some("iOS".to_string())
    } else if ua.contains("Android") {
        Some("Android".to_string())
    } else if ua.contains("Linux") {
        Some("Linux".to_string())
    } else {
        None
    };

    let device_type = if ua.contains("Mobile") || ua.contains("iPhone") || ua.contains("Android") {
        Some("mobile".to_string())
    } else {
        Some("desktop".to_string())
    };

    let device_name = match (browser.as_deref(), os.as_deref()) {
        (Some(b), Some(o)) => Some(format!("{} on {}", b, o)),
        (Some(b), None) => Some(b.to_string()),
        _ => None,
    };

    (device_name, device_type, os, browser)
}

/// Extract client IP from X-Forwarded-For or X-Real-IP headers
pub fn extract_ip(headers: &HeaderMap) -> Option<String> {
    headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            headers.get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string())
        })
}
