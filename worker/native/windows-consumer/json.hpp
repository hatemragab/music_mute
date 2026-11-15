#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

// Deliberately small wire grammar: bounded JSON, integer numbers, duplicate keys
// rejected. No paths, credential bytes or native error text in parser errors.
namespace mm {
struct Json {
  struct Decimal { std::string text; };
  using Object = std::map<std::string, Json>;
  using Array = std::vector<Json>;
  std::variant<std::nullptr_t, bool, std::int64_t, std::string, Object, Array,Decimal> value;
  Json() : value(nullptr) {}
  Json(std::nullptr_t) : value(nullptr) {}
  Json(bool v) : value(v) {}
  Json(std::int64_t v) : value(v) {}
  Json(int v) : value(static_cast<std::int64_t>(v)) {}
  Json(std::string v) : value(std::move(v)) {}
  Json(const char* v) : value(std::string(v)) {}
  Json(Object v) : value(std::move(v)) {}
  Json(Array v) : value(std::move(v)) {}
  Json(Decimal v) : value(std::move(v)) {}
  const Object& object() const { return std::get<Object>(value); }
  const Array& array() const { return std::get<Array>(value); }
  const std::string& string() const { return std::get<std::string>(value); }
  std::int64_t integer() const { return std::get<std::int64_t>(value); }
  const Json& at(const std::string& key) const { return object().at(key); }
};

class JsonParser {
  std::string_view input;
  std::size_t cursor = 0;
  std::size_t nodes = 0;
  bool browserNumbers = false;
  std::size_t nodeLimit = 512;
  [[noreturn]] static void bad() { throw std::runtime_error("BAD_REQUEST"); }
  void whitespace() {
    while (cursor < input.size() && (input[cursor] == ' ' || input[cursor] == '\r' || input[cursor] == '\n' || input[cursor] == '\t')) ++cursor;
  }
  char take() { if (cursor == input.size()) bad(); return input[cursor++]; }
  bool consume(char c) { whitespace(); if (cursor < input.size() && input[cursor] == c) { ++cursor; return true; } return false; }
  unsigned hex() {
    unsigned code = 0;
    for (int n = 0; n < 4; ++n) {
      const char c = take();
      const unsigned digit = c >= '0' && c <= '9' ? static_cast<unsigned>(c - '0') : c >= 'a' && c <= 'f' ? static_cast<unsigned>(c - 'a' + 10) : c >= 'A' && c <= 'F' ? static_cast<unsigned>(c - 'A' + 10) : 16;
      if (digit == 16) bad();
      code = code * 16 + digit;
    }
    return code;
  }
  static void utf8(std::string& out, unsigned code) {
    if (code < 0x80) out += static_cast<char>(code);
    else if (code < 0x800) { out += static_cast<char>(0xc0 | (code >> 6)); out += static_cast<char>(0x80 | (code & 63)); }
    else if (code < 0x10000) { out += static_cast<char>(0xe0 | (code >> 12)); out += static_cast<char>(0x80 | ((code >> 6) & 63)); out += static_cast<char>(0x80 | (code & 63)); }
    else { out += static_cast<char>(0xf0 | (code >> 18)); out += static_cast<char>(0x80 | ((code >> 12) & 63)); out += static_cast<char>(0x80 | ((code >> 6) & 63)); out += static_cast<char>(0x80 | (code & 63)); }
  }
  static void validateUtf8(const std::string& text) {
    for (std::size_t n = 0; n < text.size();) {
      const auto first = static_cast<unsigned char>(text[n++]);
      unsigned code = first;
      unsigned following = 0;
      unsigned minimum = 0;
      if (first >= 0xc2 && first <= 0xdf) { following = 1; code = first & 31; minimum = 0x80; }
      else if (first >= 0xe0 && first <= 0xef) { following = 2; code = first & 15; minimum = 0x800; }
      else if (first >= 0xf0 && first <= 0xf4) { following = 3; code = first & 7; minimum = 0x10000; }
      else if (first >= 0x80) bad();
      if (n + following > text.size()) bad();
      for (unsigned index = 0; index < following; ++index) {
        const auto next = static_cast<unsigned char>(text[n++]);
        if ((next & 0xc0) != 0x80) bad();
        code = (code << 6) | (next & 63);
      }
      if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xffff) >= 0xfffe) bad();
    }
  }
  std::string text() {
    if (take() != '"') bad();
    std::string out;
    for (;;) {
      const unsigned char c = static_cast<unsigned char>(take());
      if (c == '"') { validateUtf8(out); return out; }
      if (c < 32) bad();
      if (c != '\\') { out += static_cast<char>(c); continue; }
      switch (take()) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned code = hex();
          if (code >= 0xd800 && code <= 0xdbff) {
            if (take() != '\\' || take() != 'u') bad();
            const unsigned low = hex();
            if (low < 0xdc00 || low > 0xdfff) bad();
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          } else if (code >= 0xdc00 && code <= 0xdfff) bad();
          utf8(out, code); break;
        }
        default: bad();
      }
    }
  }
  Json parseValue(int depth) {
    if (depth > 8 || ++nodes > nodeLimit) bad();
    whitespace(); if (cursor == input.size()) bad();
    const char c = input[cursor];
    if (c == '"') return Json(text());
    if (consume('{')) {
      Json::Object object;
      if (consume('}')) return object;
      do {
        whitespace(); const auto key = text(); if (!consume(':')) bad();
        auto value = parseValue(depth + 1);
        if (!object.emplace(key, std::move(value)).second) bad();
        if (consume('}')) return object;
      } while (consume(','));
      bad();
    }
    if (consume('[')) {
      Json::Array array;
      if (consume(']')) return array;
      do { array.push_back(parseValue(depth + 1)); if (consume(']')) return array; } while (consume(','));
      bad();
    }
    for (const auto& [word, result] : std::vector<std::pair<std::string_view, Json>>{{"true", true}, {"false", false}, {"null", nullptr}}) {
      if (input.substr(cursor, word.size()) == word) { cursor += word.size(); return result; }
    }
    const auto numberStart=cursor;
    bool negative = consume('-');
    if (cursor == input.size() || input[cursor] < '0' || input[cursor] > '9') bad();
    std::uint64_t number = 0;
    const bool zero = input[cursor] == '0';
    int digits = 0;
    while (cursor < input.size() && input[cursor] >= '0' && input[cursor] <= '9') {
      if (++digits > 16 || (zero && digits > 1)) bad();
      number = number * 10 + static_cast<unsigned>(input[cursor++] - '0');
      if (number > 9007199254740991ULL) bad();
    }
    if(browserNumbers&&cursor<input.size()&&(input[cursor]=='.'||input[cursor]=='e'||input[cursor]=='E')) {
      if(input[cursor]=='.'){++cursor;const auto start=cursor;while(cursor<input.size()&&input[cursor]>='0'&&input[cursor]<='9')++cursor;if(cursor==start)bad();}
      if(cursor<input.size()&&(input[cursor]=='e'||input[cursor]=='E')){++cursor;if(cursor<input.size()&&(input[cursor]=='+'||input[cursor]=='-'))++cursor;const auto start=cursor;while(cursor<input.size()&&input[cursor]>='0'&&input[cursor]<='9')++cursor;if(cursor==start)bad();}
      if(cursor-numberStart>128)bad();
      return Json::Decimal{std::string(input.substr(numberStart,cursor-numberStart))};
    }
    return Json(negative ? -static_cast<std::int64_t>(number) : static_cast<std::int64_t>(number));
  }
public:
  explicit JsonParser(std::string_view source,bool allowBrowserNumbers=false) : input(source),browserNumbers(allowBrowserNumbers) { if (input.size() > 65536) bad(); }
  static Json storageJournal(std::string_view source) {
    if(source.empty()||source.size()>256*1024)bad();
    JsonParser parser(std::string_view{});parser.input=source;parser.nodeLimit=16384;
    return parser.parse();
  }
  // Only fixed authenticated runtime-quarantine files/activation records use
  // this disk grammar. Wire frames retain the 64KiB/512-node limits.
  static Json runtimeRepairInventory(std::string_view source) {
    if(source.size()>16*1024*1024)bad();
    JsonParser parser(std::string_view{});parser.input=source;parser.nodeLimit=1200004;
    return parser.parse();
  }
  // Exact OS-protected Store code inventory only; never accepted as wire input.
  static Json storeCodeInventory(std::string_view source) {
    if(source.empty()||source.size()>8*1024*1024)bad();
    JsonParser parser(std::string_view{});parser.input=source;parser.nodeLimit=400000;
    return parser.parse();
  }
  // Fixed private Library catalog only: bounded disk records contain durations.
  static Json libraryCatalog(std::string_view source) {
    if(source.empty()||source.size()>16*1024*1024)bad();
    JsonParser parser(std::string_view{},true);parser.input=source;parser.nodeLimit=1200004;
    return parser.parse();
  }
  Json parse() { auto value = parseValue(0); whitespace(); if (cursor != input.size()) bad(); return value; }
};

inline std::string dump(const Json& json) {
  if (std::holds_alternative<std::nullptr_t>(json.value)) return "null";
  if (const auto* value = std::get_if<bool>(&json.value)) return *value ? "true" : "false";
  if (const auto* value = std::get_if<std::int64_t>(&json.value)) return std::to_string(*value);
  if (const auto* value = std::get_if<Json::Decimal>(&json.value)) return value->text;
  if (const auto* value = std::get_if<std::string>(&json.value)) {
    std::string out = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char c : *value) {
      if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
      else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
      else out += static_cast<char>(c);
    }
    return out + '"';
  }
  std::string out;
  if (const auto* object = std::get_if<Json::Object>(&json.value)) {
    out = "{";
    for (const auto& [key, value] : *object) { if (out.size() > 1) out += ','; out += dump(Json(key)) + ':' + dump(value); }
    return out + '}';
  }
  out = "[";
  for (const auto& value : json.array()) { if (out.size() > 1) out += ','; out += dump(value); }
  return out + ']';
}
} // namespace mm
