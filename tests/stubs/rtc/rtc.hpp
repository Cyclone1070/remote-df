#pragma once
// A stub of the libdatachannel API for local compile checking ONLY.
//
// libdatachannel is not installed on the development machine, so
// `g++ -fsyntax-only interposer/df_streamer.cpp` stops at the missing
// rtc/rtc.hpp and never looks at the other 2300 lines. This header provides just
// the declarations the interposer uses, so the real file can be parsed and
// -Wall -Wextra can be checked before a deploy round trip.
//
// It is not usable at runtime and must never be on the include path of a real
// build: the deploy script passes -I/usr/local/include only. Check with:
//
//   g++ -std=c++17 -O1 -Wall -Wextra -fsyntax-only \
//       -I tests/stubs -I/usr/local/include interposer/df_streamer.cpp

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <variant>
#include <vector>

namespace rtc {

enum class LogLevel { Fatal, Error, Warning, Info, Debug, Verbose, None };

// Real signature has an optional callback argument; the interposer passes only
// the level.
void InitLogger(LogLevel level);

using binary = std::vector<std::byte>;
using Message = std::variant<binary, std::string>;

struct IceServer {
    explicit IceServer(const std::string& url) : url(url) {}
    std::string url;
};

struct Configuration {
    int portRangeBegin = 0;
    int portRangeEnd = 0;
    std::vector<IceServer> iceServers;
};

class Description {
public:
    Description() = default;
    Description(const std::string& sdp, const std::string& type) : sdp_(sdp), type_(type) {}
    // The real type converts to the SDP text; the interposer relies on it.
    operator std::string() const { return sdp_; }
    std::string sdp_;
    std::string type_;
};

class Candidate {
public:
    Candidate() = default;
    Candidate(const std::string& candidate, const std::string& mid) : candidate_(candidate), mid_(mid) {}
    operator std::string() const { return candidate_; }
    std::string mid() const { return mid_; }
    std::string candidate_;
    std::string mid_;
};

class DataChannel {
public:
    using MessageCallback = std::function<void(Message)>;
    void onOpen(std::function<void()> cb) { open_cb_ = std::move(cb); }
    void onClosed(std::function<void()> cb) { closed_cb_ = std::move(cb); }
    void onMessage(MessageCallback cb) { msg_cb_ = std::move(cb); }
    bool isOpen() const { return false; }
    void send(const std::byte* data, size_t size) { (void)data; (void)size; }
    size_t bufferedAmount() const { return 0; }
    std::string label() const { return label_; }

private:
    std::string label_;
    std::function<void()> open_cb_;
    std::function<void()> closed_cb_;
    MessageCallback msg_cb_;
};

class PeerConnection {
public:
    enum class State { New, Connecting, Connected, Disconnected, Failed, Closed };
    enum class GatheringState { New, InProgress, Complete };

    void onStateChange(std::function<void(State)> cb) { state_cb_ = std::move(cb); }
    void onGatheringStateChange(std::function<void(GatheringState)> cb) { gather_cb_ = std::move(cb); }
    void onLocalDescription(std::function<void(Description)> cb) { desc_cb_ = std::move(cb); }
    void onLocalCandidate(std::function<void(Candidate)> cb) { cand_cb_ = std::move(cb); }
    void onDataChannel(std::function<void(std::shared_ptr<DataChannel>)> cb) { dc_cb_ = std::move(cb); }
    void setRemoteDescription(const Description& d) { (void)d; }
    void addRemoteCandidate(const Candidate& c) { (void)c; }
    void close() {}

    explicit PeerConnection(const Configuration& c) { (void)c; }

private:
    std::function<void(State)> state_cb_;
    std::function<void(GatheringState)> gather_cb_;
    std::function<void(Description)> desc_cb_;
    std::function<void(Candidate)> cand_cb_;
    std::function<void(std::shared_ptr<DataChannel>)> dc_cb_;
};

} // namespace rtc
