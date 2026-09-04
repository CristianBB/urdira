//! Minimal JSON-RPC 2.0 codec over LSP-style `Content-Length` framing.
//!
//! `tsgo --api --async` speaks JSON-RPC over stdio using the same framing
//! `vscode-jsonrpc`'s `StreamMessageReader`/`StreamMessageWriter` use (which
//! is in turn the LSP base protocol framing): each message is preceded by
//! one or more `Header: value\r\n` lines, a blank `\r\n`, then exactly
//! `Content-Length` bytes of UTF-8 JSON. This module implements just enough
//! of that framing to talk to `tsgo` — it does not aim to be a general LSP
//! library.

use std::io::{self, BufRead, Write};

use serde_json::Value;

/// One decoded JSON-RPC message, before it's classified as a response,
/// a server request (needs a reply), or a notification.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub id: Option<Value>,
    pub method: Option<String>,
    pub params: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<RpcErrorPayload>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RpcErrorPayload {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcErrorPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "tsgo RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcErrorPayload {}

/// Reads one `Content-Length`-framed JSON-RPC message from `reader`.
/// Returns `Ok(None)` on a clean EOF before any header bytes are read
/// (i.e. the peer closed the stream between messages).
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<RawMessage>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    let mut saw_any_header_bytes = false;
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            if saw_any_header_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "tsgo closed the connection mid-header",
                ));
            }
            return Ok(None);
        }
        saw_any_header_bytes = true;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            let value = value.trim();
            content_length = Some(value.parse().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("malformed Content-Length header: {value:?}"),
                )
            })?);
        }
        // Other headers (e.g. Content-Type) are accepted and ignored.
    }
    let content_length = content_length.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "message had no Content-Length header",
        )
    })?;
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let value: Value = serde_json::from_slice(&body).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid JSON body: {e}"),
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "JSON-RPC message was not an object",
        )
    })?;
    let error = match object.get("error") {
        Some(v) if !v.is_null() => Some(serde_json::from_value(v.clone()).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid error payload: {e}"),
            )
        })?),
        _ => None,
    };
    Ok(Some(RawMessage {
        id: object.get("id").cloned(),
        method: object
            .get("method")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        params: object.get("params").cloned(),
        result: object.get("result").cloned(),
        error,
    }))
}

fn write_framed<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

/// Writes a JSON-RPC request (has an `id`, expects a response).
pub fn write_request<W: Write>(
    writer: &mut W,
    id: u64,
    method: &str,
    params: &Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    }))?;
    write_framed(writer, &body)
}

/// Writes a JSON-RPC response to a server-initiated request (an FS
/// callback). `result` is sent verbatim, including `Value::Null`.
pub fn write_response<W: Write>(writer: &mut W, id: &Value, result: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))?;
    write_framed(writer, &body)
}

/// Writes a JSON-RPC error response to a server-initiated request.
pub fn write_error_response<W: Write>(
    writer: &mut W,
    id: &Value,
    code: i64,
    message: &str,
) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))?;
    write_framed(writer, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_a_request() {
        let mut buf = Vec::new();
        write_request(&mut buf, 7, "initialize", &Value::Null).unwrap();
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        let message = read_message(&mut cursor).unwrap().expect("one message");
        assert_eq!(message.id, Some(Value::from(7)));
        assert_eq!(message.method.as_deref(), Some("initialize"));
        assert_eq!(message.params, Some(Value::Null));
    }

    #[test]
    fn round_trips_a_response() {
        let mut buf = Vec::new();
        write_response(&mut buf, &Value::from(3), &serde_json::json!({"ok": true})).unwrap();
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        let message = read_message(&mut cursor).unwrap().expect("one message");
        assert_eq!(message.id, Some(Value::from(3)));
        assert_eq!(message.result, Some(serde_json::json!({"ok": true})));
        assert!(message.error.is_none());
    }

    #[test]
    fn round_trips_an_error_response() {
        let mut buf = Vec::new();
        write_error_response(&mut buf, &Value::from(9), -32601, "Method not found").unwrap();
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        let message = read_message(&mut cursor).unwrap().expect("one message");
        let error = message.error.expect("error payload");
        assert_eq!(error.code, -32601);
        assert_eq!(error.message, "Method not found");
    }

    #[test]
    fn reads_multiple_messages_back_to_back() {
        let mut buf = Vec::new();
        write_request(&mut buf, 1, "a", &Value::Null).unwrap();
        write_request(&mut buf, 2, "b", &Value::Null).unwrap();
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        let first = read_message(&mut cursor).unwrap().unwrap();
        let second = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(first.method.as_deref(), Some("a"));
        assert_eq!(second.method.as_deref(), Some("b"));
    }

    #[test]
    fn clean_eof_before_any_message_returns_none() {
        let mut cursor = std::io::BufReader::new(Cursor::new(Vec::<u8>::new()));
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn tolerates_extra_headers() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"x","params":null}"#;
        let mut buf = Vec::new();
        write!(
            buf,
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        buf.extend_from_slice(body);
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        let message = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(message.method.as_deref(), Some("x"));
    }

    #[test]
    fn rejects_missing_content_length() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\r\n");
        let mut cursor = std::io::BufReader::new(Cursor::new(buf));
        assert!(read_message(&mut cursor).is_err());
    }
}
