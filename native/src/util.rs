use tree_sitter::Node;

/// The measured source. Trees are parsed from UTF-16 (matching node-tree-sitter, which parses
/// JavaScript strings as UTF-16 — tree-sitter's error recovery can differ between encodings), so
/// node "byte" offsets and columns are UTF-16 code units x 2; this maps them back to UTF-8 slices
/// of the original string without allocating per node.
pub struct Source<'a> {
    pub code: &'a str,
    utf8_offset_by_unit: Vec<usize>,
}

impl<'a> Source<'a> {
    pub fn new(code: &'a str) -> Source<'a> {
        let mut utf8_offset_by_unit = Vec::with_capacity(code.len() + 1);
        for (offset, character) in code.char_indices() {
            utf8_offset_by_unit.push(offset);
            // Both halves of a surrogate pair map to the character start; tree-sitter node
            // boundaries always align to whole code points, so the halves are never split.
            if character.len_utf16() == 2 {
                utf8_offset_by_unit.push(offset);
            }
        }
        utf8_offset_by_unit.push(code.len());
        Source {
            code,
            utf8_offset_by_unit,
        }
    }

    pub fn to_utf16(&self) -> Vec<u16> {
        self.code.encode_utf16().collect()
    }

    fn utf8_offset(&self, node_byte: usize) -> usize {
        self.utf8_offset_by_unit[node_byte / 2]
    }
}

pub fn node_text<'a>(node: Node<'_>, code: &Source<'a>) -> &'a str {
    &code.code[code.utf8_offset(node.start_byte())..code.utf8_offset(node.end_byte())]
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
