#!/usr/bin/env python3
import sys
import json
import os
import re

def strip_and_map(t):
    s = []
    m =[]
    for i, c in enumerate(t):
        if not c.isspace():
            s.append(c)
            m.append(i)
    return "".join(s), m

def find_block_end(text, start_idx):
    i = start_idx
    brace_depth = 0
    in_str = False
    in_char = False
    in_line_comment = False
    in_block_comment = False
    found_first_brace = False

    # Move to the first opening brace
    first_brace_search = text.find('{', i)
    if first_brace_search == -1:
        return -1 # No block to find
    i = first_brace_search

    while i < len(text):
        c = text[i]
        next_c = text[i+1] if i+1 < len(text) else ''

        if in_line_comment:
            if c == '\n': in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == '*' and next_c == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str:
            if c == '\\': i += 2; continue
            if c == '"': in_str = False
            i += 1
            continue
        if in_char:
            if c == '\\': i += 2; continue
            if c == "'": in_char = False
            i += 1
            continue

        if c == '/' and next_c == '/':
            in_line_comment = True
            i += 2
            continue
        if c == '/' and next_c == '*':
            in_block_comment = True
            i += 2
            continue
        if c == '"':
            in_str = True
            i += 1
            continue
        if c == "'":
            in_char = True
            i += 1
            continue

        if c == '{':
            brace_depth += 1
            found_first_brace = True
        elif c == '}':
            brace_depth -= 1

        if found_first_brace and brace_depth == 0:
            return i

        i += 1
    return -1

def apply_smart_replace(text, search, replace):
    if not search.strip():
        if not text.strip():
            return replace
        return text.rstrip() + "\n" + replace + "\n"

    target_s, target_m = strip_and_map(text)
    search_s, _ = strip_and_map(search)

    idx = target_s.find(search_s)
    if idx != -1:
        start_orig = target_m[idx]
        end_orig = target_m[idx + len(search_s) - 1]
        return text[:start_orig] + replace + text[end_orig + 1:]

    # Fallback to literal search if normalized search fails
    if search in text:
        return text.replace(search, replace, 1)

    raise Exception("Could not find a match for smart_replace block. Searched for:\n" + search)

def apply_entity_replace(text, entity_type, name, replace):
        # Support decorators with arguments, e.g., @customElement("my-el")
    decorators = r"(?:@\w+(?:\([^)]*\))?\s*)*"
    # Support modifiers like private, public, async, override, pub(crate), etc.
    modifiers = r"(?:[a-zA-Z0-9_\(\)]+\s+)*"
    
    if entity_type == "replace_function":
        # Lookahead for '(' (or '=...(' for arrow functions) handles TS methods without 'function' keyword
        entity_pattern = decorators + modifiers + r"(?:(?:fun|fn|function|get|set)\s+)?(?:<[^>]+>\s*)?" + re.escape(name) + r"(?=\s*(?:=\s*)?\()"
    else:
        entity_pattern = decorators + modifiers + r"(?:class|interface|object|struct|enum|trait|impl)\s+(?:<[^>]+>\s*)?" + re.escape(name) + r"\b"

    match = re.search(entity_pattern, text)
    if not match:
        raise Exception(f"Could not find entity declaration for '{name}' matching pattern: {entity_pattern}")

    start_idx = match.start()
    
    i = match.end()
    paren_depth = 0
    angle_depth = 0
    in_str = False
    in_char = False
    in_line_comment = False
    in_block_comment = False

    while i < len(text):
        c = text[i]
        next_c = text[i+1] if i+1 < len(text) else ''

        if in_line_comment:
            if c == '\n': in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == '*' and next_c == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str:
            if c == '\\': i += 2; continue
            if c == '"': in_str = False
            i += 1
            continue
        if in_char:
            if c == '\\': i += 2; continue
            if c == "'": in_char = False
            i += 1
            continue

        if c == '/' and next_c == '/':
            in_line_comment = True
            i += 2
            continue
        if c == '/' and next_c == '*':
            in_block_comment = True
            i += 2
            continue
        if c == '"':
            in_str = True
            i += 1
            continue
        if c == "'":
            in_char = True
            i += 1
            continue

        if c == '(': paren_depth += 1
        elif c == ')': paren_depth -= 1
        elif c == '<': angle_depth += 1
        elif c == '>':
            if i > 0 and text[i-1] == '=':
                pass # Ignore => arrows in TypeScript so we don't break brace parsing
            else:
                angle_depth = max(0, angle_depth - 1)
        
        if paren_depth == 0 and angle_depth == 0:
            if c == '{':
                end_idx = find_block_end(text, i)
                if end_idx == -1:
                    raise Exception(f"Could not find matching closing brace for entity '{name}'")
                return text[:start_idx] + replace + text[end_idx + 1:]
            elif c == ';':
                return text[:start_idx] + replace + text[i + 1:]
        
        i += 1

    return text[:start_idx] + replace

def main():
    if len(sys.argv) < 2:
        print("Usage: python apply_patch.py <path_to_json>")
        sys.exit(1)

    json_path = sys.argv[1]
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    summary = data.get('summary', 'No summary provided')
    print(f"\n🤖 Summary: {summary}\n")

    file_updates = {}
    files_to_delete = []

    try:
        errors =[]
        # Phase 1: Calculate all changes in-memory (Dry Run)
        for file_info in data.get('files', []):
            file_path = file_info['file_path']
            edits = file_info.get('edits',[])
            
            # CHECK FOR DELETE TYPE
            if any(e.get("type") == "delete" for e in edits):
                if os.path.exists(file_path):
                    files_to_delete.append(file_path)
                continue

            if 'code_diff' in file_info:
                diff = file_info['code_diff']
                parts = diff.split('=======')
                search = parts[0].replace('<<<<<<< SEARCH\n', '', 1)
                replace = parts[1].replace('\n>>>>>>> REPLACE', '', 1)
                edits.append({'type': 'smart_replace', 'search': search, 'replace': replace})

            if os.path.exists(file_path):
                with open(file_path, 'r', encoding='utf-8') as f:
                    text = f.read()
            else:
                text = ""

            for edit in edits:
                edit_type = edit.get('type')
                try:
                    if edit_type == 'smart_replace':
                        text = apply_smart_replace(text, edit.get('search', ''), edit['replace'])
                    elif edit_type in ('replace_function', 'replace_class', 'replace_object', 'replace_interface'):
                        text = apply_entity_replace(text, edit_type, edit['name'], edit['replace'])
                    else:
                        raise Exception(f"Unknown edit type: {edit_type} in file {file_path}")
                except Exception as e:
                    errors.append(f"[{file_path}] {e}")

            file_updates[file_path] = text

        if errors:
            print("\n❌ FATAL ERRORS FOUND DURING DRY RUN:")
            for err in errors:
                print(f"----------------------------------------\n{err}")
            print("----------------------------------------")
            print("🛑 Transaction aborted. No files were modified on disk.")
            sys.exit(1)

        # Phase 2: Write to disk only if EVERYTHING succeeded
        
        # Handle Deletions
        for path in files_to_delete:
            os.remove(path)
            print(f"🗑️  DELETED: {path}")

        # Handle Updates/Creations
        for path, new_text in file_updates.items():
            dir_name = os.path.dirname(path)
            if dir_name:
                os.makedirs(dir_name, exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_text)
            print(f"✅ {path} updated successfully.")

        print(f"\nDone. {len(file_updates) + len(files_to_delete)} file operations completed successfully.")

    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        print("🛑 Transaction aborted. No files were modified on disk.")
        sys.exit(1)

if __name__ == "__main__":
    main()
