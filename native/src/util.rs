use tree_sitter::Node;

pub fn node_text<'a>(node: Node<'_>, code: &'a str) -> &'a str {
    &code[node.byte_range()]
}

pub fn named_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

pub fn all_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

pub fn find_children_by_field_name<'t>(node: Node<'t>, field_name: &str) -> Vec<Node<'t>> {
    let mut children = Vec::new();
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index) {
            if node.field_name_for_child(index as u32) == Some(field_name) {
                children.push(child);
            }
        }
    }
    children
}

/// UTF-16 column of a node start, matching node-tree-sitter (it parses UTF-16, so its columns are
/// code units, and downstream consumers such as the TypeScript-project component matcher rely on
/// that unit).
pub fn utf16_column(code: &str, start_byte: usize, byte_column: usize) -> usize {
    let line_start = start_byte - byte_column;
    code[line_start..start_byte].encode_utf16().count()
}

/// Splits like JavaScript's `code.split(/\r\n|\n|\r/)`, with `[]` for empty input as in classifyLines.
pub fn split_lines(code: &str) -> Vec<&str> {
    if code.is_empty() {
        return Vec::new();
    }
    let bytes = code.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                lines.push(&code[start..index]);
                index += if bytes.get(index + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = index;
            }
            b'\n' => {
                lines.push(&code[start..index]);
                index += 1;
                start = index;
            }
            _ => index += 1,
        }
    }
    lines.push(&code[start..]);
    lines
}

/// JavaScript's `\s` character class (WhiteSpace + LineTerminator), which `String.prototype.trim`
/// also uses; Rust's `char::is_whitespace` differs (it excludes U+FEFF), so this is spelled out.
pub fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn strip_js_whitespace(text: &str) -> String {
    text.chars()
        .filter(|character| !is_js_whitespace(*character))
        .collect()
}

/// JavaScript ToInt32 for integer-valued numbers (all hash arithmetic stays below 2^53).
pub fn to_int32(value: i64) -> i32 {
    value as i32
}
