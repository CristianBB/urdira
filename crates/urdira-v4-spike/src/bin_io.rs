//! Minimal little-endian binary I/O helpers. Hand-rolled instead of pulling
//! in `byteorder`/`serde`/`bincode`: the spike's cache format is a handful of
//! fixed-width fields plus a couple of length-prefixed blobs, and writing it
//! by hand keeps the on-disk shape fully explicit (useful when the same
//! process later has to explain, in the evidence doc, exactly what a "row"
//! costs in bytes).

use std::io::{self, Read, Write};

pub fn write_u8(w: &mut impl Write, v: u8) -> io::Result<()> {
    w.write_all(&[v])
}

pub fn write_u16(w: &mut impl Write, v: u16) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_u32(w: &mut impl Write, v: u32) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_u64(w: &mut impl Write, v: u64) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_bytes32(w: &mut impl Write, v: &[u8; 32]) -> io::Result<()> {
    w.write_all(v)
}

pub fn write_lp_bytes(w: &mut impl Write, v: &[u8]) -> io::Result<()> {
    write_u32(w, v.len() as u32)?;
    w.write_all(v)
}

pub fn write_lp_str(w: &mut impl Write, v: &str) -> io::Result<()> {
    write_lp_bytes(w, v.as_bytes())
}

pub fn read_u8(r: &mut impl Read) -> io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

pub fn read_u16(r: &mut impl Read) -> io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}

pub fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

pub fn read_u64(r: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

pub fn read_bytes32(r: &mut impl Read) -> io::Result<[u8; 32]> {
    let mut b = [0u8; 32];
    r.read_exact(&mut b)?;
    Ok(b)
}

pub fn read_lp_bytes(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let len = read_u32(r)? as usize;
    let mut b = vec![0u8; len];
    r.read_exact(&mut b)?;
    Ok(b)
}

pub fn read_lp_string(r: &mut impl Read) -> io::Result<String> {
    let bytes = read_lp_bytes(r)?;
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Hex-decode the 64 hex characters that follow a `<prefix>:` in a v3 text
/// id, e.g. `record:aa..` or `sha256:aa..`, into a 32-byte array.
pub fn hex64_after_prefix(s: &str) -> Option<[u8; 32]> {
    let (_, hex) = s.split_once(':')?;
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
