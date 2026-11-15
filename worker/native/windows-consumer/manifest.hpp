#pragma once

// A regex can match an asInvoker element in malformed XML or alongside a
// second execution level. XmlLite parses the bounded signed PE resource,
// rejects DTD/external entities and requires one unambiguous level.
void assertAsInvokerManifest(const BYTE* data,DWORD size) {
  if(!data||size<1||size>65536)fail("HELPER_INTEGRITY_INVALID");
  winrt::com_ptr<IStream> stream;stream.attach(SHCreateMemStream(data,size));
  if(!stream)fail("HELPER_INTEGRITY_INVALID");
  winrt::com_ptr<IXmlReader> reader;
  if(FAILED(CreateXmlReader(__uuidof(IXmlReader),reader.put_void(),nullptr))||
    FAILED(reader->SetProperty(XmlReaderProperty_DtdProcessing,DtdProcessing_Prohibit))||
    FAILED(reader->SetProperty(XmlReaderProperty_MaxElementDepth,64))||
    FAILED(reader->SetInput(stream.get())))fail("HELPER_INTEGRITY_INVALID");
  unsigned levels=0;XmlNodeType node{};HRESULT result=S_OK;
  while((result=reader->Read(&node))==S_OK){
    if(node!=XmlNodeType_Element)continue;
    const wchar_t* name=nullptr;UINT length=0;
    if(FAILED(reader->GetLocalName(&name,&length)))fail("HELPER_INTEGRITY_INVALID");
    if(std::wstring_view(name,length)!=L"requestedExecutionLevel")continue;
    if(++levels!=1||reader->MoveToAttributeByName(L"level",nullptr)!=S_OK)fail("HELPER_INTEGRITY_INVALID");
    const wchar_t* value=nullptr;UINT count=0;
    if(FAILED(reader->GetValue(&value,&count))||std::wstring_view(value,count)!=L"asInvoker")fail("HELPER_INTEGRITY_INVALID");
    const auto access=reader->MoveToAttributeByName(L"uiAccess",nullptr);
    if(access==S_OK){if(FAILED(reader->GetValue(&value,&count))||std::wstring_view(value,count)!=L"false")fail("HELPER_INTEGRITY_INVALID");}
    else if(access!=S_FALSE)fail("HELPER_INTEGRITY_INVALID");
    if(FAILED(reader->MoveToElement()))fail("HELPER_INTEGRITY_INVALID");
  }
  if(result!=S_FALSE||levels!=1)fail("HELPER_INTEGRITY_INVALID");
}
