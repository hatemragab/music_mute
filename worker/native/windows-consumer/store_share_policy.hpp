#pragma once
#include "store_data_policy.hpp"

namespace mmstoresharepolicy {
inline bool operation(std::string_view value) noexcept {
  return value=="store_share_start" || value=="store_share_inspect" || value=="store_share_cancel" ||
    value=="store_share_cleanup_acknowledge" || value=="store_share_cleanup_completed";
}
inline bool requestId(std::string_view value) {
  if(value.size()!=36 || value[14]<'1' || value[14]>'5' || std::string_view("89ab").find(value[19])==std::string_view::npos) return false;
  for(std::size_t n=0;n<value.size();++n) {
    if(n==8||n==13||n==18||n==23) { if(value[n]!='-') return false; }
    else if(std::string_view("0123456789abcdef").find(value[n])==std::string_view::npos) return false;
  }
  return true;
}
inline bool input(std::string_view operationName,const mm::Json& args) noexcept {
  using namespace mmstorerole::data_policy;
  try {
    if(!operation(operationName)) return false;
    if(operationName=="store_share_cleanup_completed") return fields(args,{});
    if(operationName=="store_share_inspect") return fields(args,{"request_id"}) && requestId(args.at("request_id").string());
    if(operationName!="store_share_start") return fields(args,{"request_id","nonce"}) && requestId(args.at("request_id").string()) && mmstore::validDigest(args.at("nonce").string());
    if(!fields(args,{"request_id","window_handle","window_owner","relative_path","sha256","bytes","title","mime"}) ||
       !requestId(args.at("request_id").string()) || !identity(args.at("window_owner")) || !digits(args.at("window_handle").string(),20) ||
       !mmstore::validDigest(args.at("sha256").string()) || !integer(args.at("bytes"),1,256*1024*1024)) return false;
    const auto& title=args.at("title").string(); if(title.empty()||title.size()>180) return false;
    for(const unsigned char c:title) if(c<32||c==127) return false;
    const auto prefix="share\\requests\\"+args.at("request_id").string()+"\\media.";
    const auto& path=args.at("relative_path").string(); if(!path.starts_with(prefix)) return false;
    const auto extension=path.substr(prefix.size());
    const std::map<std::string,std::string> mimes{{"mp3","audio/mpeg"},{"m4a","audio/mp4"},{"webm","audio/webm"},{"ogg","audio/ogg"},{"aac","audio/aac"},{"wav","audio/wav"},{"flac","audio/flac"}};
    const auto found=mimes.find(extension);
    return found!=mimes.end() && found->second==args.at("mime").string();
  } catch(...) { return false; }
}
}
