use tree_sitter::Node;

/// The measured source. Trees are parsed from UTF-16 (matching node-tree-sitter, which parses
/// JavaScript strings as UTF-16 — tree-sitter's error recovery can differ between encodings), so
/// node "byte" offsets and columns are UTF-16 code units x 2; this maps them back to UTF-8 slices
/// of the original string without allocating per node.
pub struct Source<'a> {
    pub code: &'a str,
    /// UTF-16 unit -> UTF-8 byte offset. None for pure-ASCII sources, where the two coincide, so
    /// the table's 4-bytes-per-unit cost is only paid for sources that actually need mapping.
    utf8_offset_by_unit: Option<Vec<u32>>,
}

impl<'a> Source<'a> {
    pub fn new(code: &'a str) -> Source<'a> {
        if code.is_ascii() {
            return Source {
                code,
                utf8_offset_by_unit: None,
            };
        }
        let mut utf8_offset_by_unit = Vec::with_capacity(code.len() + 1);
        for (offset, character) in code.char_indices() {
            utf8_offset_by_unit.push(offset as u32);
            // Both halves of a surrogate pair map to the character start; tree-sitter node
            // boundaries always align to whole code points, so the halves are never split.
            if character.len_utf16() == 2 {
                utf8_offset_by_unit.push(offset as u32);
            }
        }
        utf8_offset_by_unit.push(code.len() as u32);
        Source {
            code,
            utf8_offset_by_unit: Some(utf8_offset_by_unit),
        }
    }

    pub fn to_utf16(&self) -> Vec<u16> {
        self.code.encode_utf16().collect()
    }

    fn utf8_offset(&self, node_byte: usize) -> usize {
        match &self.utf8_offset_by_unit {
            None => node_byte / 2,
            Some(map) => map[node_byte / 2] as usize,
        }
    }
}

pub fn node_text<'a>(node: Node<'_>, code: &Source<'a>) -> &'a str {
    &code.code[code.utf8_offset(node.start_byte())..code.utf8_offset(node.end_byte())]
}

/// Kotlin spells the bound receiver of a callable reference (`xs::size`) as a `type_identifier`,
/// the same kind as an unbound type (`List::size`); the receiver position is what distinguishes
/// it, and only a visible definition then tells a variable from a type.
pub fn is_kotlin_callable_receiver(node: Node<'_>) -> bool {
    node.kind() == "type_identifier"
        && node.parent().is_some_and(|parent| {
            parent.kind() == "callable_reference"
                && parent
                    .named_child(0)
                    .is_some_and(|first| first.id() == node.id())
        })
}

/// Whether the node is a leaf for token-level walks. Kotlin soft keywords used as names (`value`,
/// `data`, `get`, ...) parse as a `simple_identifier` wrapping an anonymous keyword token, so a
/// plain leaf check would see the keyword instead of the identifier.
pub fn is_identifier_leaf(node: Node<'_>) -> bool {
    node.child_count() == 0 || node.kind() == "simple_identifier"
}

pub fn named_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

pub fn all_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

/// Children carrying the field, with node-tree-sitter's vendored-core semantics: extra children
/// (error-recovery nodes, comments) inherit the field of the preceding structural sibling.
/// tree-sitter 0.22.6 instead reports no field for extras (ts_node_field_name_for_child gained an
/// is_extra early return), which would desynchronize field-based extraction on malformed source.
pub fn find_children_by_field_name<'t>(node: Node<'t>, field_name: &str) -> Vec<Node<'t>> {
    let mut children = Vec::new();
    let mut preceding_structural_field: Option<&'static str> = None;
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index) {
            let field = if child.is_extra() {
                preceding_structural_field
            } else {
                let field = node.field_name_for_child(index as u32);
                preceding_structural_field = field;
                field
            };
            if field == Some(field_name) {
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

/// JavaScript ToInt32 for integer-valued numbers (all hash arithmetic stays below 2^53).
pub fn to_int32(value: i64) -> i32 {
    value as i32
}

/// The body following a Kotlin `if_expression`'s bare `else` keyword (the grammar has no else
/// clause node and no fields), or None for other languages' if nodes and else-less ifs.
pub fn kotlin_else_body(if_node: Node<'_>) -> Option<Node<'_>> {
    if if_node.kind() != "if_expression" {
        return None;
    }
    let children = all_children(if_node);
    let else_index = children
        .iter()
        .position(|child| !child.is_named() && child.kind() == "else")?;
    children[else_index + 1..]
        .iter()
        .copied()
        .find(|child| child.kind() == "control_structure_body")
}

/// Kotlin's `try { } catch { }` shares its node kind with Rust's `?` operator; only the Kotlin form
/// holds a body or clause child.
pub fn is_kotlin_try_expression(node: Node<'_>) -> bool {
    node.kind() == "try_expression"
        && named_children(node)
            .iter()
            .any(|child| matches!(child.kind(), "statements" | "catch_block" | "finally_block"))
}

/// Whether a Kotlin else body is a braceless `else if`: the nested if sits directly in the
/// control_structure_body, whereas a braced `else { if ... }` wraps it in `statements`.
pub fn is_kotlin_else_if_body(else_body: Node<'_>) -> bool {
    named_children(else_body)
        .iter()
        .any(|child| child.kind() == "if_expression")
}
