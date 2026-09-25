CXX ?= g++
CXXFLAGS ?= -shared -fPIC -O3 -Wall -Wextra -std=c++17 -I/usr/local/include
LDFLAGS ?= -ldl -lpthread -lzstd -ldatachannel -lssl -lcrypto

TARGET = libdf_streamer.so
SRCS = df_streamer.cpp

all: $(TARGET)

$(TARGET): $(SRCS) sha1_b64.hpp ws_server.hpp
	$(CXX) $(CXXFLAGS) $(SRCS) -o $(TARGET) $(LDFLAGS)

clean:
	rm -f $(TARGET)
