// Tátão — captura de áudio de um app (ex.: Spotify) ou do PC inteiro, sem pegar o som do próprio Tátão.
// Usa a captura por processo do Windows (Windows 10 2004 ou mais novo).
//
//   tatao-audio.exe list <pid-do-tatao>
//       lista os apps com som: uma linha "pid<TAB>ativo<TAB>exe" por app (UTF-8)
//   tatao-audio.exe capture include <pid> <pid-do-tatao>   -> só o som desse app (e dos processos filhos)
//   tatao-audio.exe capture exclude <pid> <pid-do-tatao>   -> todo o som do PC, menos desse app (o Tátão)
//       stderr: "READY <taxa> <canais>" e depois o áudio cru em stdout (PCM 16 bits intercalado)
//       stderr: "ERR <hresult> <texto>" se não der
//
// Fecha sozinho quando o Tátão fecha (ou quando a saída é fechada).
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <map>

#ifdef _MSC_VER
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#endif

// Estruturas da ativação por processo (definidas aqui pra compilar com qualquer SDK)
struct TataoLoopbackParams {
  DWORD ActivationType;     // 1 = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
  DWORD TargetProcessId;
  DWORD ProcessLoopbackMode; // 0 = incluir árvore do processo, 1 = excluir
};
static const wchar_t* kProcessLoopbackDevice = L"VAD\\Process_Loopback";

static void errOut(HRESULT hr, const char* what) {
  fprintf(stderr, "ERR 0x%08lx %s\n", (unsigned long)hr, what);
  fflush(stderr);
}

// ---------------- processos ----------------
struct ProcInfo { DWORD parent; std::wstring exe; };
static std::map<DWORD, ProcInfo> snapshotProcs() {
  std::map<DWORD, ProcInfo> m;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return m;
  PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do { m[pe.th32ProcessID] = ProcInfo{ pe.th32ParentProcessID, pe.szExeFile }; } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return m;
}
static bool sameExe(const std::wstring& a, const std::wstring& b) { return _wcsicmp(a.c_str(), b.c_str()) == 0; }
// sobe pelos pais enquanto for o mesmo programa (Spotify, Chrome… abrem vários processos)
static DWORD rootOf(const std::map<DWORD, ProcInfo>& m, DWORD pid) {
  DWORD cur = pid;
  for (int i = 0; i < 32; i++) {
    auto it = m.find(cur); if (it == m.end()) break;
    auto par = m.find(it->second.parent);
    if (par == m.end() || par->first == cur || !sameExe(par->second.exe, it->second.exe)) break;
    cur = par->first;
  }
  return cur;
}
static bool inTreeOf(const std::map<DWORD, ProcInfo>& m, DWORD pid, DWORD ancestor) {
  DWORD cur = pid;
  for (int i = 0; i < 64; i++) {
    if (cur == ancestor) return true;
    auto it = m.find(cur); if (it == m.end() || it->second.parent == cur || it->second.parent == 0) return false;
    cur = it->second.parent;
  }
  return false;
}
static std::string utf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), NULL, 0, NULL, NULL);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, NULL, NULL);
  return s;
}

// ---------------- list ----------------
static int cmdList(DWORD selfPid) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr)) { errOut(hr, "CoInitializeEx"); return 2; }
  IMMDeviceEnumerator* en = NULL;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (FAILED(hr)) { errOut(hr, "MMDeviceEnumerator"); return 2; }
  IMMDeviceCollection* col = NULL;
  hr = en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col);
  if (FAILED(hr)) { errOut(hr, "EnumAudioEndpoints"); en->Release(); return 2; }
  std::map<DWORD, ProcInfo> procs = snapshotProcs();
  std::map<DWORD, int> found; // pid raiz -> ativo
  UINT nDev = 0; col->GetCount(&nDev);
  for (UINT d = 0; d < nDev; d++) {
    IMMDevice* dev = NULL; if (FAILED(col->Item(d, &dev))) continue;
    IAudioSessionManager2* mgr = NULL;
    if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, (void**)&mgr))) {
      IAudioSessionEnumerator* se = NULL;
      if (SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
        int n = 0; se->GetCount(&n);
        for (int i = 0; i < n; i++) {
          IAudioSessionControl* ctl = NULL; if (FAILED(se->GetSession(i, &ctl))) continue;
          IAudioSessionControl2* ctl2 = NULL;
          if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2))) {
            DWORD pid = 0; AudioSessionState st = AudioSessionStateInactive;
            ctl2->GetProcessId(&pid); ctl->GetState(&st);
            bool system = ctl2->IsSystemSoundsSession() == S_OK;
            if (pid && !system && st != AudioSessionStateExpired && !inTreeOf(procs, pid, selfPid)) {
              DWORD root = rootOf(procs, pid);
              int act = st == AudioSessionStateActive ? 1 : 0;
              if (!found.count(root) || act) found[root] = act;
            }
            ctl2->Release();
          }
          ctl->Release();
        }
        se->Release();
      }
      mgr->Release();
    }
    dev->Release();
  }
  col->Release(); en->Release();
  for (auto& f : found) {
    auto it = procs.find(f.first);
    std::string exe = it != procs.end() ? utf8(it->second.exe) : std::string("?");
    printf("%lu\t%d\t%s\n", (unsigned long)f.first, f.second, exe.c_str());
  }
  fflush(stdout);
  return 0;
}

// ---------------- capture ----------------
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG ref_ = 1;
 public:
  HANDLE done;
  HRESULT result = E_FAIL;
  IAudioClient* client = NULL;
  ActivateHandler() { done = CreateEventW(NULL, TRUE, FALSE, NULL); }
  virtual ~ActivateHandler() { if (done) CloseHandle(done); }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, __uuidof(IUnknown)) || IsEqualIID(riid, __uuidof(IActivateAudioInterfaceCompletionHandler)))
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (IsEqualIID(riid, __uuidof(IAgileObject)))
      *ppv = static_cast<IAgileObject*>(this);
    else { *ppv = NULL; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override { LONG r = InterlockedDecrement(&ref_); if (r == 0) delete this; return (ULONG)r; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrAct = E_FAIL; IUnknown* unk = NULL;
    HRESULT hr = op->GetActivateResult(&hrAct, &unk);
    if (SUCCEEDED(hr) && SUCCEEDED(hrAct) && unk) result = unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
    else result = FAILED(hr) ? hr : (FAILED(hrAct) ? hrAct : E_NOINTERFACE);
    if (unk) unk->Release();
    SetEvent(done);
    return S_OK;
  }
};

static bool writeAll(HANDLE out, const void* data, DWORD n) {
  const BYTE* p = (const BYTE*)data;
  while (n) {
    DWORD w = 0;
    if (!WriteFile(out, p, n, &w, NULL) || w == 0) return false;
    p += w; n -= w;
  }
  return true;
}

static int cmdCapture(bool include, DWORD target, DWORD parentPid) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr)) { errOut(hr, "CoInitializeEx"); return 2; }

  TataoLoopbackParams params;
  params.ActivationType = 1;
  params.TargetProcessId = target;
  params.ProcessLoopbackMode = include ? 0 : 1;
  PROPVARIANT pv; PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = (BYTE*)&params;

  ActivateHandler* h = new ActivateHandler();
  IActivateAudioInterfaceAsyncOperation* op = NULL;
  hr = ActivateAudioInterfaceAsync(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, h, &op);
  if (FAILED(hr)) { errOut(hr, "ActivateAudioInterfaceAsync"); return 3; }
  if (WaitForSingleObject(h->done, 8000) != WAIT_OBJECT_0) { errOut(E_FAIL, "timeout na ativacao"); return 3; }
  if (op) op->Release();
  if (FAILED(h->result) || !h->client) { errOut(h->result, "ativacao"); return 3; }
  IAudioClient* ac = h->client;

  // a captura por processo não informa o formato: a gente pede 48 kHz, estéreo, 16 bits
  WAVEFORMATEX fmt; memset(&fmt, 0, sizeof(fmt));
  fmt.wFormatTag = WAVE_FORMAT_PCM; fmt.nChannels = 2; fmt.wBitsPerSample = 16;
  const DWORD rates[2] = { 48000, 44100 };
  const DWORD flagSets[2] = {
    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
  };
  bool inited = false;
  for (int r = 0; r < 2 && !inited; r++) {
    for (int f = 0; f < 2 && !inited; f++) {
      fmt.nSamplesPerSec = rates[r];
      fmt.nBlockAlign = (WORD)(fmt.nChannels * fmt.wBitsPerSample / 8);
      fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
      hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, flagSets[f], 200000 /* 20 ms */, 0, &fmt, NULL);
      if (SUCCEEDED(hr)) inited = true;
    }
  }
  if (!inited) { errOut(hr, "Initialize"); return 4; }

  IAudioCaptureClient* cap = NULL;
  hr = ac->GetService(__uuidof(IAudioCaptureClient), (void**)&cap);
  if (FAILED(hr)) { errOut(hr, "GetService"); return 4; }
  HANDLE ev = CreateEventW(NULL, FALSE, FALSE, NULL);
  hr = ac->SetEventHandle(ev);
  if (FAILED(hr)) { errOut(hr, "SetEventHandle"); return 4; }
  hr = ac->Start();
  if (FAILED(hr)) { errOut(hr, "Start"); return 4; }

  HANDLE parent = parentPid ? OpenProcess(SYNCHRONIZE, FALSE, parentPid) : NULL;
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  fprintf(stderr, "READY %lu %u\n", (unsigned long)fmt.nSamplesPerSec, (unsigned)fmt.nChannels);
  fflush(stderr);

  std::vector<BYTE> zeros;
  HANDLE waits[2] = { ev, parent };
  DWORD nWaits = parent ? 2 : 1;
  int code = 0;
  for (;;) {
    DWORD w = WaitForMultipleObjects(nWaits, waits, FALSE, 250);
    if (w == WAIT_OBJECT_0 + 1) break;           // o Tátão fechou
    if (w == WAIT_FAILED) { code = 5; break; }
    UINT32 next = 0;
    bool fail = false;
    while (SUCCEEDED(hr = cap->GetNextPacketSize(&next)) && next > 0) {
      BYTE* data = NULL; UINT32 frames = 0; DWORD flags = 0;
      hr = cap->GetBuffer(&data, &frames, &flags, NULL, NULL);
      if (FAILED(hr)) { fail = true; break; }
      DWORD bytes = frames * fmt.nBlockAlign;
      bool ok;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (zeros.size() < bytes) zeros.assign(bytes, 0);
        ok = writeAll(out, zeros.data(), bytes);
      } else ok = writeAll(out, data, bytes);
      cap->ReleaseBuffer(frames);
      if (!ok) { fail = true; break; }             // ninguém mais lendo
    }
    if (FAILED(hr) && hr != AUDCLNT_S_BUFFER_EMPTY) fail = true;
    if (fail) { code = 6; break; }
  }
  ac->Stop();
  cap->Release(); ac->Release();
  if (parent) CloseHandle(parent);
  CloseHandle(ev);
  return code;
}

int main(int argc, char** argv) {
  if (argc >= 2 && strcmp(argv[1], "list") == 0) {
    return cmdList(argc >= 3 ? (DWORD)strtoul(argv[2], NULL, 10) : 0);
  }
  if (argc >= 4 && strcmp(argv[1], "capture") == 0) {
    bool include = strcmp(argv[2], "include") == 0;
    if (!include && strcmp(argv[2], "exclude") != 0) { errOut(E_INVALIDARG, "modo invalido"); return 1; }
    DWORD target = (DWORD)strtoul(argv[3], NULL, 10);
    DWORD parent = argc >= 5 ? (DWORD)strtoul(argv[4], NULL, 10) : 0;
    if (!target) { errOut(E_INVALIDARG, "pid invalido"); return 1; }
    return cmdCapture(include, target, parent);
  }
  fprintf(stderr, "uso: tatao-audio list <pid> | capture include|exclude <pid> <pid-pai>\n");
  return 1;
}
