package com.simproxy.app;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Парсер IP пакетов для обработки трафика через TUN интерфейс
 */
public class IpPacketParser {
    private static final String TAG = "IpPacketParser";

    // IPv4 constants
    private static final int IPV4_VERSION = 4;
    private static final int IPV6_VERSION = 6;
    private static final int PROTOCOL_TCP = 6;
    private static final int PROTOCOL_UDP = 17;
    private static final int PROTOCOL_ICMP = 1;

    private ByteBuffer buffer;

    public IpPacketParser(byte[] data) {
        this.buffer = ByteBuffer.wrap(data);
    }

    /**
     * Получает версию IP (4 или 6)
     */
    public int getIpVersion() {
        if (buffer.capacity() < 1) return 0;
        int firstByte = buffer.get(0) & 0xFF;
        return (firstByte >> 4) & 0xF;
    }

    /**
     * Проверяет, IPv4 ли пакет
     */
    public boolean isIPv4() {
        return getIpVersion() == IPV4_VERSION;
    }

    /**
     * Получает протокол (TCP, UDP, ICMP)
     */
    public int getProtocol() {
        int version = getIpVersion();
        if (version == IPV4_VERSION) {
            if (buffer.capacity() < 10) return 0;
            return buffer.get(9) & 0xFF;
        } else if (version == IPV6_VERSION) {
            if (buffer.capacity() < 7) return 0;
            return buffer.get(6) & 0xFF; // Next Header field in IPv6
        }
        return 0;
    }

    /**
     * Получает исходный IP адрес
     */
    public String getSourceIp() {
        if (!isIPv4() || buffer.capacity() < 16) return null;
        byte[] ip = new byte[4];
        buffer.position(12);
        buffer.get(ip);
        return ipToString(ip);
    }

    /**
     * Получает целевой IP адрес
     */
    public String getDestinationIp() {
        if (!isIPv4() || buffer.capacity() < 20) return null;
        byte[] ip = new byte[4];
        buffer.position(16);
        buffer.get(ip);
        return ipToString(ip);
    }

    /**
     * Получает исходный порт (для TCP/UDP)
     */
    public int getSourcePort() {
        if (!isIPv4()) return 0;
        int protocol = getProtocol();
        if (protocol != PROTOCOL_TCP && protocol != PROTOCOL_UDP) return 0;
        int headerLen = getHeaderLength();
        if (buffer.capacity() < headerLen + 4) return 0;
        buffer.position(headerLen);
        return ((buffer.get() & 0xFF) << 8) | (buffer.get() & 0xFF);
    }

    /**
     * Получает целевой порт (для TCP/UDP)
     */
    public int getDestinationPort() {
        if (!isIPv4()) return 0;
        int protocol = getProtocol();
        if (protocol != PROTOCOL_TCP && protocol != PROTOCOL_UDP) return 0;
        int headerLen = getHeaderLength();
        if (buffer.capacity() < headerLen + 4) return 0;
        buffer.position(headerLen + 2);
        return ((buffer.get() & 0xFF) << 8) | (buffer.get() & 0xFF);
    }

    /**
     * Получает длину IP заголовка
     */
    public int getHeaderLength() {
        if (buffer.capacity() < 1) return 0;
        int firstByte = buffer.get(0) & 0xFF;
        return ((firstByte & 0xF) * 4);
    }

    /**
     * Получает общую длину пакета
     */
    public int getTotalLength() {
        if (buffer.capacity() < 3) return 0;
        buffer.position(2);
        return ((buffer.get() & 0xFF) << 8) | (buffer.get() & 0xFF);
    }

    /**
     * Конвертирует байты IP адреса в строку
     */
    private static String ipToString(byte[] ip) {
        if (ip == null || ip.length != 4) return null;
        return (ip[0] & 0xFF) + "." + (ip[1] & 0xFF) + "." +
               (ip[2] & 0xFF) + "." + (ip[3] & 0xFF);
    }

    /**
     * Является ли пакет TCP
     */
    public boolean isTcp() {
        return getProtocol() == PROTOCOL_TCP;
    }

    /**
     * Является ли пакет UDP
     */
    public boolean isUdp() {
        return getProtocol() == PROTOCOL_UDP;
    }

    /**
     * Является ли пакет ICMP
     */
    public boolean isIcmp() {
        return getProtocol() == PROTOCOL_ICMP;
    }
}

