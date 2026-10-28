//! The wire protocol is mirrored by hand: `model.rs` on the Rust side and
//! `types.ts` on the TypeScript side, with nothing in the build comparing them.
//! A renamed variant would only show up as a window that quietly stops
//! reacting, so this test reads both sources and names the tag that drifted.
//!
//! It parses the two files instead of generating one from the other on purpose:
//! generation would mean the TypeScript side loses the comments that explain
//! what each field carries.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

const MODEL: &str = "src/model.rs";
const TYPES: &str = "../../apps/desktop/src/types.ts";

fn source(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// serde's `rename_all = "camelCase"` lowercases the first character and leaves
/// the rest alone, so `BackendTLSPolicies` travels as `backendTLSPolicies` — not
/// the `backendTlsPolicies` a word splitter would produce.
fn serde_camel_case(variant: &str) -> String {
    let mut chars = variant.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The variants of `pub enum <name>`, in the camelCase serde sends them.
fn rust_variants(model: &str, name: &str) -> BTreeSet<String> {
    let header = format!("pub enum {name} {{");
    let start = model
        .find(&header)
        .unwrap_or_else(|| panic!("no `{header}` in {MODEL}"))
        + header.len();
    let body = &model[start..];
    let end = body
        .find("\n}")
        .unwrap_or_else(|| panic!("`{header}` has no closing brace in {MODEL}"));
    body[..end]
        .lines()
        // Variants sit at one level of indentation; their fields, their
        // attributes and their doc comments sit deeper.
        .filter(|line| line.starts_with("    ") && !line.starts_with("     "))
        .filter(|line| !line.trim_start().starts_with('#') && !line.trim_start().starts_with("//"))
        .filter_map(|line| {
            line.trim_start()
                .split(|char: char| !char.is_alphanumeric())
                .next()
        })
        .filter(|word| word.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
        .map(serde_camel_case)
        .collect()
}

/// The body of `export type <name> = …` in `types.ts`, up to the next export.
fn ts_body<'a>(types: &'a str, name: &str) -> &'a str {
    let header = format!("export type {name}");
    let mut from = 0;
    loop {
        let at = types[from..]
            .find(&header)
            .unwrap_or_else(|| panic!("no `{header}` in {TYPES}"))
            + from;
        let after = at + header.len();
        // `export type View` must not match `export type ViewModel`.
        if !types[after..].starts_with(|char: char| char.is_alphanumeric()) {
            let body = &types[after..];
            return &body[..body.find("\nexport ").unwrap_or(body.len())];
        }
        from = after;
    }
}

/// The tag of every member of `export type <name> = …`, quoted members included.
fn ts_tags(types: &str, name: &str) -> BTreeSet<String> {
    let body = ts_body(types, name);

    let chars: Vec<char> = body.chars().collect();
    let mut tags = BTreeSet::new();
    let mut index = 0;
    while index < chars.len() {
        // A member starts after `|`, or right after the `=` for the first one.
        if chars[index] != '|' && chars[index] != '=' {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        match chars.get(cursor) {
            Some('{') => {
                cursor += 1;
                while cursor < chars.len() && chars[cursor].is_whitespace() {
                    cursor += 1;
                }
                let tag_start = cursor;
                while cursor < chars.len()
                    && (chars[cursor].is_alphanumeric() || chars[cursor] == '_')
                {
                    cursor += 1;
                }
                let tag: String = chars[tag_start..cursor].iter().collect();
                let mut after = cursor;
                while after < chars.len() && chars[after].is_whitespace() {
                    after += 1;
                }
                // `{ context: … }` nested inside a member is a field, not a tag.
                if !tag.is_empty() && chars.get(after) == Some(&':') {
                    tags.insert(tag);
                }
            }
            Some('"') => {
                cursor += 1;
                let tag_start = cursor;
                while cursor < chars.len() && chars[cursor] != '"' {
                    cursor += 1;
                }
                tags.insert(chars[tag_start..cursor].iter().collect());
            }
            _ => {}
        }
        index = cursor;
    }
    tags
}

fn assert_mirrored(name: &str) {
    let rust = rust_variants(&source(MODEL), name);
    let typescript = ts_tags(&source(TYPES), name);
    let rust_only: Vec<&String> = rust.difference(&typescript).collect();
    let typescript_only: Vec<&String> = typescript.difference(&rust).collect();
    assert!(
        rust_only.is_empty() && typescript_only.is_empty(),
        "{name} drifted between {MODEL} and {TYPES}:\n  \
         in {MODEL} but not in {TYPES}: {rust_only:?}\n  \
         in {TYPES} but not in {MODEL}: {typescript_only:?}"
    );
}

#[test]
fn command_tags_are_mirrored() {
    assert_mirrored("Command");
}

#[test]
fn app_event_tags_are_mirrored() {
    assert_mirrored("AppEvent");
}

#[test]
fn resource_kind_tags_are_mirrored() {
    assert_mirrored("ResourceKind");
}

#[test]
fn status_tone_tags_are_mirrored() {
    assert_mirrored("StatusTone");
}

#[test]
fn watch_target_tags_are_mirrored() {
    assert_mirrored("WatchTarget");
}

/// Both parsers read a shape that a reformat could quietly change, so a silently
/// empty set has to fail here rather than pass the comparisons above.
#[test]
fn the_parsers_find_the_protocol() {
    assert!(rust_variants(&source(MODEL), "Command").len() > 20);
    assert!(ts_tags(&source(TYPES), "Command").len() > 20);
    assert!(rust_variants(&source(MODEL), "AppEvent").len() > 20);
    assert!(ts_tags(&source(TYPES), "AppEvent").len() > 20);
}

#[test]
fn serde_camel_case_lowercases_only_the_first_letter() {
    assert_eq!(serde_camel_case("LoadContexts"), "loadContexts");
    assert_eq!(serde_camel_case("BackendTLSPolicies"), "backendTLSPolicies");
    assert_eq!(
        serde_camel_case("CustomResourceDefinitions"),
        "customResourceDefinitions"
    );
}
