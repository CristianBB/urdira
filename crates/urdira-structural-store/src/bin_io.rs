//! Minimal little-endian binary I/O helpers for the small, non-mmap'd
//! dictionary files. Hand-rolled for the same reason as
//! `urdira-v4-spike/src/bin_io.rs`: the shape is explicit and small, and
//! writing it out keeps the byte layout easy to describe in the evidence
//! doc without pulling in `bincode`/`serde` for this one piece.

use std::io::{self, Read, Write};

pub fn write_u32(w: &mut impl Write, v: u32) -> io::Result<()> {
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
pub fn write_str_list(w: &mut impl Write, values: &[String]) -> io::Result<()> {
    write_u32(w, values.len() as u32)?;
    for v in values {
        write_lp_str(w, v)?;
    }
    Ok(())
}
pub fn write_str_pair_list(w: &mut impl Write, values: &[(String, String)]) -> io::Result<()> {
    write_u32(w, values.len() as u32)?;
    for (a, b) in values {
        write_lp_str(w, a)?;
        write_lp_str(w, b)?;
    }
    Ok(())
}
pub fn write_bytes32_list(w: &mut impl Write, values: &[[u8; 32]]) -> io::Result<()> {
    write_u32(w, values.len() as u32)?;
    for v in values {
        write_bytes32(w, v)?;
    }
    Ok(())
}

pub fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
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
pub fn read_str_list(r: &mut impl Read) -> io::Result<Vec<String>> {
    let n = read_u32(r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_lp_string(r)?);
    }
    Ok(out)
}
pub fn read_str_pair_list(r: &mut impl Read) -> io::Result<Vec<(String, String)>> {
    let n = read_u32(r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let a = read_lp_string(r)?;
        let b = read_lp_string(r)?;
        out.push((a, b));
    }
    Ok(out)
}
pub fn read_bytes32_list(r: &mut impl Read) -> io::Result<Vec<[u8; 32]>> {
    let n = read_u32(r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_bytes32(r)?);
    }
    Ok(out)
}
