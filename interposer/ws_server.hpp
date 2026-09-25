#include <cstdarg>

static void ws_log(const char* fmt, ...) {
    FILE* fp = fopen("/tmp/ws_server.log", "a");
    if (!fp) return;
    va_list args;
    va_start(args, fmt);
    vfprintf(fp, fmt, args);
    va_end(args);
    fclose(fp);
}

#pragma once
#include <iostream>
#include <vector>
#include <string>
#include <sstream>
#include <unordered_map>
#include <mutex>
#include <thread>
#include <atomic>
#include <algorithm>
#include <cstring>
#include <cstdint>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/stat.h>
#include "sha1_b64.hpp"

// Forward declaration
void handle_client_input_event(const uint8_t* data, size_t len);
void sync_client_textures(int fd);
void handle_client_text_message(int fd, const std::string& msg);
void handle_client_disconnected(int fd);

enum ClientState {
    STATE_HTTP,
    STATE_WS,
    STATE_DEAD
};

struct WsClient {
    int fd;
    ClientState state;
    std::vector<uint8_t> rx_buf;
};

class EmbeddedServer {
private:
    int server_fd = -1;
    int port = 8484;
    std::string web_root = "/tmp/remote-df/client";
    std::atomic<bool> running{false};
    std::thread server_thread;
    std::mutex clients_lock;
    std::vector<WsClient> clients;

    void set_nonblocking(int fd) {
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    std::string get_mime_type(const std::string& path) {
        if (path.find(".html") != std::string::npos) return "text/html; charset=utf-8";
        if (path.find(".js") != std::string::npos) return "application/javascript";
        if (path.find(".css") != std::string::npos) return "text/css";
        if (path.find(".png") != std::string::npos) return "image/png";
        if (path.find(".json") != std::string::npos) return "application/json";
        return "application/octet-stream";
    }

    void handle_http_request(WsClient& client, const std::string& req) {
        ws_log("[WS] handle_http fd=%d req_len=%zu\n", client.fd, req.size()); fflush(stderr);
        std::istringstream iss(req);
        std::string method, path, version;
        iss >> method >> path >> version;

        bool is_ws_upgrade = false;
        std::string ws_key;
        std::string line;
        while (std::getline(iss, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            std::string lower_line = line;
            std::transform(lower_line.begin(), lower_line.end(), lower_line.begin(), ::tolower);
            if (lower_line.find("upgrade: websocket") != std::string::npos) {
                is_ws_upgrade = true;
            }
            if (lower_line.find("sec-websocket-key:") != std::string::npos) {
                size_t colon = line.find(':');
                if (colon != std::string::npos) {
                    ws_key = line.substr(colon + 1);
                    while (!ws_key.empty() && ws_key.front() == ' ') ws_key.erase(ws_key.begin());
                    while (!ws_key.empty() && ws_key.back() == ' ') ws_key.pop_back();
                }
            }
        }

        if (is_ws_upgrade && !ws_key.empty()) {
            ws_log("[WS] upgrade websocket fd=%d\n", client.fd); fflush(stderr);
            std::string accept_key = compute_ws_accept(ws_key);
            std::string res = "HTTP/1.1 101 Switching Protocols\r\n"
                              "Upgrade: websocket\r\n"
                              "Connection: Upgrade\r\n"
                              "Sec-WebSocket-Accept: " + accept_key + "\r\n\r\n";
            send_raw(client.fd, res.data(), res.size());
            client.state = STATE_WS;
            client.rx_buf.clear();

            std::string init_json = "{\"type\":\"init\",\"grid_w\":160,\"grid_h\":60,\"font_w\":8,\"font_h\":12}";
            send_ws_text(client.fd, init_json);

            sync_client_textures(client.fd);
            return;
        }

        // Static file serving
        size_t qpos = path.find("?");
        if (qpos != std::string::npos) path = path.substr(0, qpos);
        if (path == "/" || path.empty()) path = "/index.html";
        if (path.find("..") != std::string::npos) {
            std::string res = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
            send_raw(client.fd, res.data(), res.size());
            client.state = STATE_DEAD;
            return;
        }

        std::string full_path = web_root + path;
        FILE* fp = fopen(full_path.c_str(), "rb");
        if (!fp) {
            std::string res = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
            send_raw(client.fd, res.data(), res.size());
            client.state = STATE_DEAD;
            return;
        }

        fseek(fp, 0, SEEK_END);
        long sz = ftell(fp);
        fseek(fp, 0, SEEK_SET);

        std::vector<uint8_t> body(sz);
        size_t read_bytes = fread(body.data(), 1, sz, fp);
        fclose(fp);

        std::string mime = get_mime_type(full_path);
        std::ostringstream oss;
        oss << "HTTP/1.1 200 OK\r\n"
            << "Content-Type: " << mime << "\r\n"
            << "Content-Length: " << read_bytes << "\r\n"
            << "Connection: close\r\n"
            << "Cache-Control: no-cache, no-store, must-revalidate\r\n"
            << "Pragma: no-cache\r\n"
            << "Expires: 0\r\n"
            << "Access-Control-Allow-Origin: *\r\n\r\n";
        std::string header_str = oss.str();

        send_raw(client.fd, header_str.data(), header_str.size());
        if (read_bytes > 0) {
            send_raw(client.fd, body.data(), read_bytes);
        }
        client.state = STATE_DEAD;
    }

    void handle_ws_frames(WsClient& client) {
        while (client.rx_buf.size() >= 2) {
            uint8_t b0 = client.rx_buf[0];
            uint8_t b1 = client.rx_buf[1];
            uint8_t opcode = b0 & 0x0F;
            bool masked = (b1 & 0x80) != 0;
            uint64_t payload_len = b1 & 0x7F;

            size_t header_len = 2;
            if (payload_len == 126) {
                if (client.rx_buf.size() < 4) return;
                payload_len = ((uint64_t)client.rx_buf[2] << 8) | client.rx_buf[3];
                header_len = 4;
            } else if (payload_len == 127) {
                if (client.rx_buf.size() < 10) return;
                payload_len = 0;
                for (int i = 0; i < 8; i++) {
                    payload_len = (payload_len << 8) | client.rx_buf[2 + i];
                }
                header_len = 10;
            }

            size_t mask_len = masked ? 4 : 0;
            if (client.rx_buf.size() < header_len + mask_len + payload_len) {
                return;
            }

            uint8_t mask[4] = {0, 0, 0, 0};
            if (masked) {
                memcpy(mask, &client.rx_buf[header_len], 4);
            }

            uint8_t* payload = &client.rx_buf[header_len + mask_len];
            if (masked) {
                for (size_t i = 0; i < payload_len; i++) {
                    payload[i] ^= mask[i % 4];
                }
            }

            if (opcode == 0x08) {
                client.state = STATE_DEAD;
                return;
            } else if (opcode == 0x09) {
                send_ws_pong(client.fd, payload, payload_len);
            } else if (opcode == 0x01) {
                std::string msg((const char*)payload, payload_len);
                handle_client_text_message(client.fd, msg);
            } else if (opcode == 0x02) {
                handle_client_input_event(payload, payload_len);
            }

            size_t total_consumed = header_len + mask_len + payload_len;
            client.rx_buf.erase(client.rx_buf.begin(), client.rx_buf.begin() + total_consumed);
        }
    }

    void send_ws_pong(int fd, const uint8_t* data, size_t len) {
        std::vector<uint8_t> frame;
        frame.push_back(0x8A);
        frame.push_back((uint8_t)(len & 0x7F));
        frame.insert(frame.end(), data, data + len);
        send_raw(fd, frame.data(), frame.size());
    }

    bool send_raw(int fd, const void* data, size_t len) {
        const uint8_t* ptr = (const uint8_t*)data;
        size_t total = 0;
        while (total < len) {
            ssize_t n = send(fd, ptr + total, len - total, MSG_NOSIGNAL);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
                    usleep(100);
                    continue;
                }
                return false;
            }
            total += n;
        }
        return true;
    }

public:
    EmbeddedServer() = default;
    ~EmbeddedServer() { stop(); }

    bool start(int p = 8484, const std::string& root = "/tmp/remote-df/client") {
        ws_log("[WS] start called p=%d root=%s\n", p, root.c_str()); fflush(stderr);
        port = p;
        web_root = root;

        server_fd = socket(AF_INET, SOCK_STREAM, 0);
        if (server_fd < 0) return false;

        int opt = 1;
        setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
        set_nonblocking(server_fd);

        sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(port);

        if (bind(server_fd, (sockaddr*)&addr, sizeof(addr)) < 0) {
            close(server_fd);
            server_fd = -1;
            return false;
        }

        if (listen(server_fd, 64) < 0) {
            close(server_fd);
            server_fd = -1;
            return false;
        }

        running = true;
        server_thread = std::thread(&EmbeddedServer::run_loop, this);
        return true;
    }

    void stop() {
        if (!running) return;
        running = false;
        if (server_fd >= 0) {
            close(server_fd);
            server_fd = -1;
        }
        if (server_thread.joinable()) {
            server_thread.join();
        }
        std::lock_guard<std::mutex> lock(clients_lock);
        for (auto& c : clients) {
            if (c.fd >= 0) close(c.fd);
        }
        clients.clear();
    }

    void run_loop() {
        ws_log("[WS] run_loop thread started! server_fd=%d\n", server_fd); fflush(stderr);
        while (running) {
            std::vector<pollfd> pfd;
            pfd.push_back({server_fd, POLLIN, 0});

            {
                std::lock_guard<std::mutex> lock(clients_lock);
                for (const auto& c : clients) {
                    if (c.fd >= 0) {
                        pfd.push_back({c.fd, POLLIN, 0});
                    }
                }
            }

            int ret = poll(pfd.data(), pfd.size(), 10);
            if (ret < 0) { ws_log("[WS] poll error errno=%d\n", errno); sleep(1); }
            static int loop_cnt = 0; if (++loop_cnt % 500 == 0) { ws_log("[WS] poll heartbeat clients=%zu\n", clients.size()); fflush(stderr); }
            if (ret <= 0) continue;

            if (pfd[0].revents) ws_log("[WS] revents=%d\n", pfd[0].revents);
            if (pfd[0].revents & POLLIN) {
                while (true) {
                    sockaddr_in client_addr;
                    socklen_t client_len = sizeof(client_addr);
                    int c_fd = accept(server_fd, (sockaddr*)&client_addr, &client_len);
                    if (c_fd >= 0) { ws_log("[WS] accept fd=%d\n", c_fd); fflush(stderr); }
                    if (c_fd < 0) break;

                    int nodelay = 1;
                    setsockopt(c_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
                    int buf_size = 4 * 1024 * 1024;
                    setsockopt(c_fd, SOL_SOCKET, SO_SNDBUF, &buf_size, sizeof(buf_size));
                    setsockopt(c_fd, SOL_SOCKET, SO_RCVBUF, &buf_size, sizeof(buf_size));
                    set_nonblocking(c_fd);

                    std::lock_guard<std::mutex> lock(clients_lock);
                    clients.push_back({c_fd, STATE_HTTP, {}});
                }
            }

            {
                std::lock_guard<std::mutex> lock(clients_lock);
                for (size_t i = 1; i < pfd.size(); i++) {
                    int c_fd = pfd[i].fd;
                    auto it = std::find_if(clients.begin(), clients.end(), [c_fd](const WsClient& c){ return c.fd == c_fd; });
                    if (it == clients.end()) continue;

                    if (pfd[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
                        it->state = STATE_DEAD;
                        continue;
                    }

                    if (pfd[i].revents & POLLIN) {
                        uint8_t tmp[8192];
                        while (true) {
                            ssize_t n = recv(c_fd, tmp, sizeof(tmp), 0);
                            if (n > 0) {
                                it->rx_buf.insert(it->rx_buf.end(), tmp, tmp + n);
                            } else {
                                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
                                it->state = STATE_DEAD;
                                break;
                            }
                        }

                        if (it->state == STATE_HTTP) {
                            std::string req(it->rx_buf.begin(), it->rx_buf.end());
                            size_t header_end = req.find("\r\n\r\n");
                            if (header_end != std::string::npos) {
                                handle_http_request(*it, req);
                            }
                        } else if (it->state == STATE_WS) {
                            handle_ws_frames(*it);
                        }
                    }
                }

                for (auto it = clients.begin(); it != clients.end(); ) {
                    if (it->state == STATE_DEAD) {
                        handle_client_disconnected(it->fd);
                        close(it->fd);
                        it = clients.erase(it);
                    } else {
                        ++it;
                    }
                }
            }
        }
    }

    bool send_ws_text(int fd, const std::string& text) {
        std::vector<uint8_t> frame;
        frame.reserve(10 + text.size());
        frame.push_back(0x81); // Text frame opcode
        size_t len = text.size();
        if (len < 126) {
            frame.push_back((uint8_t)len);
        } else if (len <= 65535) {
            frame.push_back(126);
            frame.push_back((uint8_t)((len >> 8) & 0xFF));
            frame.push_back((uint8_t)(len & 0xFF));
        } else {
            frame.push_back(127);
            for (int i = 7; i >= 0; i--) {
                frame.push_back((uint8_t)((len >> (i * 8)) & 0xFF));
            }
        }
        frame.insert(frame.end(), text.begin(), text.end());
        return send_raw(fd, frame.data(), frame.size());
    }

    bool send_ws_binary(int fd, const void* data, size_t len) {
        std::vector<uint8_t> frame;
        frame.reserve(10 + len);
        frame.push_back(0x82);

        if (len < 126) {
            frame.push_back((uint8_t)len);
        } else if (len <= 65535) {
            frame.push_back(126);
            frame.push_back((uint8_t)((len >> 8) & 0xFF));
            frame.push_back((uint8_t)(len & 0xFF));
        } else {
            frame.push_back(127);
            for (int i = 7; i >= 0; i--) {
                frame.push_back((uint8_t)((len >> (i * 8)) & 0xFF));
            }
        }

        const uint8_t* ptr = (const uint8_t*)data;
        frame.insert(frame.end(), ptr, ptr + len);
        return send_raw(fd, frame.data(), frame.size());
    }

    void broadcast_ws_binary(const void* data, size_t len) {
        std::lock_guard<std::mutex> lock(clients_lock);
        for (auto& c : clients) {
            if (c.state == STATE_WS) {
                if (!send_ws_binary(c.fd, data, len)) {
                    c.state = STATE_DEAD;
                }
            }
        }
    }

    size_t active_ws_clients() {
        std::lock_guard<std::mutex> lock(clients_lock);
        size_t cnt = 0;
        for (const auto& c : clients) {
            if (c.state == STATE_WS) cnt++;
        }
        return cnt;
    }
};
