//! Inside the sandbox: agent instructions live in /workspace/AGENTS.md and CLAUDE.md. They were once copied in only
//! when missing, so improvements never reached an existing workspace. Now DeviceDock owns ONE marked section of those
//! files and refreshes it at every start (the bridge does this); anything else in the file belongs to the user and is
//! never touched.
use crate::protocol::js_space;
use sha2::{Digest, Sha256};
use std::path::Path;

/// What the section is made from (sandbox/AGENTS.md, copied into the image).
pub const SOURCE: &str = "/opt/devicedock/sandbox/AGENTS.md";
pub const VERSION: u32 = 2;
const BEGIN_PREFIX: &str = "<!-- devicedock:begin v";
const END: &str = "<!-- devicedock:end -->";
/// SHA-256 of earlier whole-file seeds. A file that still matches one byte for byte was never edited by the user.
pub const LEGACY_SHA256: [&str; 1] = ["d77656bba86f6cc7a05e6b62d377894de988197e99eb47f964b4994bfd58777e"];

fn wrap(block: &str) -> String {
    format!("{BEGIN_PREFIX}{VERSION} -->\n{}\n{END}\n", block.trim_matches(js_space))
}

fn sha(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Byte offset of the first `<!-- devicedock:begin v<digits> -->`.
fn find_begin(s: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = s[from..].find(BEGIN_PREFIX) {
        let at = from + i;
        let rest = &s[at + BEGIN_PREFIX.len()..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(" -->") {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

/// The file's new content: `existing` with the DeviceDock section added or refreshed.
pub fn merge_managed(existing: Option<&str>, block: &str, legacy: &[&str]) -> String {
    let section = wrap(block);
    let Some(existing) = existing.filter(|e| !e.trim_matches(js_space).is_empty()) else { return section };
    if let (Some(begin), Some(end)) = (find_begin(existing), existing.find(END)) {
        if end > begin {
            let after = &existing[end + END.len()..];
            return format!("{}{section}{}", &existing[..begin], after.strip_prefix('\n').unwrap_or(after));
        }
    }
    if legacy.contains(&sha(existing).as_str()) {
        return section; // an untouched old seed: replace the whole file
    }
    format!("{}\n\n{section}", existing.trim_end_matches(js_space)) // the user's own file: keep it, append our section
}

pub fn sync(path: &Path, source: &Path) -> std::io::Result<()> {
    let block = String::from_utf8_lossy(&std::fs::read(source)?).into_owned();
    let before = if path.exists() { Some(String::from_utf8_lossy(&std::fs::read(path)?).into_owned()) } else { None };
    let after = merge_managed(before.as_deref(), &block, &LEGACY_SHA256);
    if before.as_deref() != Some(after.as_str()) {
        std::fs::write(path, after)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn merge(existing: Option<&str>, block: &str) -> String {
        merge_managed(existing, block, &LEGACY_SHA256)
    }

    #[test]
    fn a_missing_file_gets_just_the_managed_section() {
        let out = merge(None, "# Hardware\nuse device list");
        assert!(out.starts_with(&format!("<!-- devicedock:begin v{VERSION} -->")));
        assert!(out.trim_end().ends_with("<!-- devicedock:end -->"));
        assert!(out.contains("use device list"));
        assert_eq!(merge(Some(" \n"), "x"), merge(None, "x"));
    }

    #[test]
    fn the_section_is_refreshed_in_place_and_the_users_text_is_untouched() {
        let old = "# My project\nnotes\n\n<!-- devicedock:begin v1 -->\nOLD TEXT\n<!-- devicedock:end -->\n\n## My own rules\nbe nice\n";
        let out = merge(Some(old), "NEW TEXT");
        assert!(out.contains("# My project\nnotes"));
        assert!(out.contains("## My own rules\nbe nice"));
        assert!(out.contains("NEW TEXT"));
        assert!(!out.contains("OLD TEXT"));
        assert_eq!(out.matches("devicedock:begin").count(), 1);
        assert_eq!(merge(Some(&out), "NEW TEXT"), out, "refreshing again changes nothing");
        assert_eq!(
            out,
            "# My project\nnotes\n\n<!-- devicedock:begin v2 -->\nNEW TEXT\n<!-- devicedock:end -->\n\n## My own rules\nbe nice\n"
        );
    }

    #[test]
    fn an_untouched_old_seed_is_replaced_and_an_edited_one_kept_with_our_section_appended() {
        let seed = "old seed text\n";
        assert_eq!(merge_managed(Some(seed), "NEW", &[&sha(seed)]), merge(None, "NEW"));
        let edited = "old seed text\nplus the user's own line\n";
        let out = merge_managed(Some(edited), "NEW", &[&sha(seed)]);
        assert!(out.starts_with("old seed text\nplus the user's own line"));
        assert!(out.contains("NEW"));
        assert!(out.find("plus the user's own line") < out.find("devicedock:begin"));
    }

    #[test]
    fn a_file_with_unrelated_content_gets_the_section_appended_after_a_blank_line() {
        assert!(merge(Some("# Mine\nhello"), "NEW").starts_with("# Mine\nhello\n\n<!-- devicedock:begin"));
        assert!(merge(Some("# Mine\nhello  \n\n\n"), "NEW").starts_with("# Mine\nhello\n\n<!-- devicedock:begin"));
        // A begin marker without a version is not ours.
        assert!(merge(Some("<!-- devicedock:begin v -->\n<!-- devicedock:end -->"), "NEW").contains("v -->\n<!-- devicedock:end -->\n\n"));
    }

    #[test]
    fn the_fingerprint_of_the_first_shipped_seed_is_registered() {
        assert_eq!(LEGACY_SHA256.len(), 1);
        assert!(LEGACY_SHA256.iter().all(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())));
        assert_eq!(sha("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn sync_writes_only_when_something_changed() {
        let dir = std::env::temp_dir().join(format!("dd-instr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("src.md"), "# Hardware\n").unwrap();
        std::fs::write(dir.join("AGENTS.md"), "mine\n").unwrap();
        sync(&dir.join("AGENTS.md"), &dir.join("src.md")).unwrap();
        let once = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert_eq!(once, "mine\n\n<!-- devicedock:begin v2 -->\n# Hardware\n<!-- devicedock:end -->\n");
        sync(&dir.join("AGENTS.md"), &dir.join("src.md")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(), once);
        assert!(sync(&dir.join("CLAUDE.md"), &dir.join("missing.md")).is_err());
        assert!(!dir.join("CLAUDE.md").exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
