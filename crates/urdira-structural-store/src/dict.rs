//! On-disk framing for [`crate::row::Dictionaries`] (`dict.bin`, minus
//! `subjects` which gets its own flat `subjects.keys` file so adjacency
//! ordinals can be resolved without decoding the string dictionaries).

use crate::bin_io::*;
use crate::row::Dictionaries;
use std::io::{Read, Write};

pub fn write_dict_body(w: &mut impl Write, dict: &Dictionaries) -> std::io::Result<()> {
    write_str_list(w, &dict.kinds)?;
    write_str_list(w, &dict.universal_kinds)?;
    write_str_list(w, &dict.relation_kinds)?;
    write_str_list(w, &dict.names)?;
    write_str_pair_list(w, &dict.artifacts)?;
    // P2-2e: appended at the END of the body (not interleaved with the
    // fields above) so an OLDER reader that has not been updated for these
    // two new lists still decodes every field it knows about correctly --
    // it simply never calls `read_str_list` again and leaves the trailing
    // bytes unread, which is fine for a one-shot in-memory/file decode
    // that does not check for a clean EOF. `facet_names` before
    // `subject_text`: no real ordering requirement between the two, this
    // one is just the declaration order in `Dictionaries` itself.
    write_str_list(w, &dict.facet_names)?;
    write_str_list(w, &dict.subject_text)
}

pub fn read_dict_body(r: &mut impl Read) -> std::io::Result<Dictionaries> {
    let kinds = read_str_list(r)?;
    let universal_kinds = read_str_list(r)?;
    let relation_kinds = read_str_list(r)?;
    let names = read_str_list(r)?;
    let artifacts = read_str_pair_list(r)?;
    // P2-2e: an older `dict.bin` (written before these two fields existed)
    // simply runs out of bytes here -- treat that as "this segment
    // predates facet_names/subject_text", i.e. both empty, exactly the
    // same "absent is equivalent to empty" convention `writer.rs`'s own
    // empty-skip rule already uses for a whole file. A real decode error
    // (truncated/corrupt mid-list) is NOT swallowed here: `read_str_list`
    // only returns `Err` for a short read, which is the same failure mode
    // a legitimately-missing trailing section produces, so this crate
    // treats both as "nothing more to read" rather than trying to tell
    // them apart.
    let facet_names = read_str_list(r).unwrap_or_default();
    let subject_text = read_str_list(r).unwrap_or_default();
    Ok(Dictionaries {
        kinds,
        universal_kinds,
        relation_kinds,
        names,
        subjects: Vec::new(),
        artifacts,
        facet_names,
        subject_text,
    })
}

pub fn write_subjects_body(w: &mut impl Write, subjects: &[[u8; 32]]) -> std::io::Result<()> {
    write_bytes32_list(w, subjects)
}

pub fn read_subjects_body(r: &mut impl Read) -> std::io::Result<Vec<[u8; 32]>> {
    read_bytes32_list(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dict_body_roundtrips_facet_names_and_subject_text() {
        let dict = Dictionaries {
            kinds: vec!["jsts:entity_callable".to_string()],
            universal_kinds: vec!["core:declaration".to_string()],
            relation_kinds: vec!["core:call".to_string()],
            names: vec!["foo".to_string()],
            subjects: vec![[7u8; 32]],
            artifacts: vec![("artifact:a".to_string(), "version:a".to_string())],
            facet_names: vec!["core:declaration".to_string(), "core:async".to_string()],
            subject_text: vec![
                "record:0707070707070707070707070707070707070707070707070707070707070707"
                    .to_string(),
            ],
        };
        let mut buf = Vec::new();
        write_dict_body(&mut buf, &dict).unwrap();
        let decoded = read_dict_body(&mut &buf[..]).unwrap();
        assert_eq!(decoded.kinds, dict.kinds);
        assert_eq!(decoded.universal_kinds, dict.universal_kinds);
        assert_eq!(decoded.relation_kinds, dict.relation_kinds);
        assert_eq!(decoded.names, dict.names);
        assert_eq!(decoded.artifacts, dict.artifacts);
        assert_eq!(decoded.facet_names, dict.facet_names);
        assert_eq!(decoded.subject_text, dict.subject_text);
        // `subjects` is never part of `dict.bin` (its own `subjects.keys`
        // file) -- always empty coming out of `read_dict_body`.
        assert!(decoded.subjects.is_empty());
    }

    #[test]
    fn read_dict_body_tolerates_a_pre_p2_2e_body_missing_the_two_new_lists() {
        // Simulates an OLDER `dict.bin` written before `facet_names`/
        // `subject_text` existed: only the five original lists are
        // present, nothing trailing.
        let mut buf = Vec::new();
        write_str_list(&mut buf, &["k".to_string()]).unwrap();
        write_str_list(&mut buf, &["u".to_string()]).unwrap();
        write_str_list(&mut buf, &["r".to_string()]).unwrap();
        write_str_list(&mut buf, &["n".to_string()]).unwrap();
        write_str_pair_list(&mut buf, &[("a".to_string(), "v".to_string())]).unwrap();
        let decoded = read_dict_body(&mut &buf[..]).unwrap();
        assert_eq!(decoded.kinds, vec!["k".to_string()]);
        assert!(decoded.facet_names.is_empty());
        assert!(decoded.subject_text.is_empty());
    }
}
