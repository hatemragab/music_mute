#include "json.hpp"
#include <cassert>
#include <iostream>

int main() {
  for (const auto* invalid : {"{\"a\":1,\"a\":2}", "1.5", "01", "9007199254740992", "{\"a\":1,}", "[1,]", "\"\\ud800\"", "\"\\udfff\"", "\"\\uffff\"", "\"\\ufdd0\"", "\"\xc0\x80\"", "\"\xed\xa0\x80\"", "true trailing", "[", "\"\n\""}) {
    bool rejected = false;
    try { (void)mm::JsonParser(invalid).parse(); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
  }
  const auto unicode = mm::JsonParser("{\"value\":\"\\ud83d\\ude80 العربية\\n\",\"integer\":19045,\"empty\":null,\"flags\":[true,false]}").parse();
  assert(unicode.at("integer").integer() == 19045);
  assert(unicode.at("value").string() == "🚀 العربية\n");
  assert(mm::dump(mm::JsonParser(mm::dump(unicode)).parse()) == mm::dump(unicode));
  bool oversized = false;
  try { (void)mm::JsonParser(std::string(65537, ' ')).parse(); } catch (const std::exception&) { oversized = true; }
  assert(oversized);
  std::string diskArray="[";
  for(unsigned n=0;n<600;++n){if(n)diskArray+=',';diskArray+='1';}diskArray+=']';
  bool wireNodesRejected=false;try{(void)mm::JsonParser(diskArray).parse();}catch(const std::exception&){wireNodesRejected=true;}assert(wireNodesRejected);
  assert(mm::JsonParser::runtimeRepairInventory(diskArray).array().size()==600);
  assert(mm::JsonParser::storageJournal(diskArray).array().size()==600);
  mm::Json::Array rows;
  for(unsigned n=0;n<256;++n){const auto suffix=std::to_string(n);mm::Json::Object row{{"id",suffix},{"relativePath","personal\\results\\"+suffix+".pending"},{"kind","tree"},{"owner",mm::Json::Object{{"sid","fixture"},{"sessionId",1},{"pid",1},{"creationTime","1"}}},{"settled",false},{"createdAt",1},{"birth",mm::Json::Object{{"device","1"},{"fileId",suffix},{"bornAt","1"}}}};if(n<64)row.emplace("input",mm::Json::Object{{"bytes",1},{"expiresAt",2},{"birth",mm::Json::Object{{"name","source.mp3"},{"directory",mm::Json::Object{{"device","1"},{"fileId",suffix},{"bornAt","1"}}},{"file",mm::Json::Object{{"device","1"},{"fileId",suffix},{"bornAt","1"}}}}}});rows.emplace_back(row);}
  const auto journal=mm::dump(mm::Json::Object{{"version",1},{"writes",rows}});
  assert(mm::JsonParser::storageJournal(journal).at("writes").array().size()==256);
  for(const auto* duplicate:{"{\"version\":1,\"version\":1,\"writes\":[]}","{\"version\":1,\"\\u0076ersion\":1,\"writes\":[]}"}){bool rejected=false;try{(void)mm::JsonParser::storageJournal(duplicate);}catch(const std::exception&){rejected=true;}assert(rejected);}
  bool journalBoundRejected=false;try{(void)mm::JsonParser::storageJournal(std::string(256*1024+1,' '));}catch(const std::exception&){journalBoundRejected=true;}assert(journalBoundRejected);
  std::string tooMany="[";for(unsigned n=0;n<16384;++n){if(n)tooMany+=',';tooMany+='0';}tooMany+=']';
  bool journalNodesRejected=false;try{(void)mm::JsonParser::storageJournal(tooMany);}catch(const std::exception&){journalNodesRejected=true;}assert(journalNodesRejected);
  bool diskBoundRejected=false;try{(void)mm::JsonParser::runtimeRepairInventory(std::string(16*1024*1024+1,' '));}catch(const std::exception&){diskBoundRejected=true;}assert(diskBoundRejected);
  const auto browser=mm::JsonParser("{\"protocol_version\":1,\"duration_seconds\":12.5e-1}",true).parse();
  assert(browser.at("protocol_version").integer()==1);
  assert(mm::dump(browser.at("duration_seconds"))=="12.5e-1");
  const auto library=mm::JsonParser::libraryCatalog("{\"version\":1,\"durationSeconds\":0.125}");assert(library.at("version").integer()==1&&mm::dump(library.at("durationSeconds"))=="0.125");
  for(const auto* malformed:{"{\"version\":1,\"version\":1}","{\"version\":1,\"\\u0076ersion\":1}","\"\\ud800\""}){bool rejected=false;try{(void)mm::JsonParser::libraryCatalog(malformed);}catch(const std::exception&){rejected=true;}assert(rejected);}
  bool catalogBoundRejected=false;try{(void)mm::JsonParser::libraryCatalog(std::string(16*1024*1024+1,' '));}catch(const std::exception&){catalogBoundRejected=true;}assert(catalogBoundRejected);
  for(const auto* malformed:{"1.","1e+","1e","1.2.3"}){bool rejected=false;try{(void)mm::JsonParser(malformed,true).parse();}catch(const std::exception&){rejected=true;}assert(rejected);}
  std::cout << "Consumer JSON parser policy passed\n";
}
