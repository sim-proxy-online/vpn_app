package com.simproxy.app;

import android.util.Log;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;

/**
 * ConnectionValidator — проверяет работоспособность VPN туннеля.
 * Валидирует доступность SOCKS прокси и внешних серверов через туннель.
 */
public class ConnectionValidator {
    private static final String TAG = "ConnValidator";

    public enum ValidationResult {
        OK, SOCKS_UNREACHABLE, EXTERNAL_UNREACHABLE, TIMEOUT, UNKNOWN_ERROR
    }

    /**
     * Проверяет доступность локального SOCKS прокси
     */
    public static ValidationResult validateSocks(String address, int port, int timeoutMs) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(address, port), timeoutMs);
            Log.d(TAG, "SOCKS proxy is reachable at " + address + ":" + port);
            return ValidationResult.OK;
        } catch (SocketTimeoutException e) {
            Log.w(TAG, "SOCKS timeout: " + e.getMessage());
            return ValidationResult.TIMEOUT;
        } catch (Exception e) {
            Log.e(TAG, "SOCKS unreachable: " + e.getMessage());
            return ValidationResult.SOCKS_UNREACHABLE;
        }
    }

    /**
     * Проверяет внешнюю доступность через туннель
     */
    public static ValidationResult validateExternal(String testServer, int port, int timeoutMs) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(testServer, port), timeoutMs);
            Log.d(TAG, "External server is reachable through VPN tunnel");
            return ValidationResult.OK;
        } catch (SocketTimeoutException e) {
            Log.w(TAG, "External server timeout: " + e.getMessage());
            return ValidationResult.TIMEOUT;
        } catch (Exception e) {
            Log.e(TAG, "External server unreachable: " + e.getMessage());
            return ValidationResult.EXTERNAL_UNREACHABLE;
        }
    }

    /**
     * Комплексная проверка: SOCKS + external
     */
    public static boolean validateConnection(String socksAddr, int socksPort, 
                                              String testServer, int testPort, int timeoutMs) {
        ValidationResult socksResult = validateSocks(socksAddr, socksPort, timeoutMs);
        if (socksResult != ValidationResult.OK) {
            Log.e(TAG, "SOCKS validation failed: " + socksResult);
            return false;
        }

        ValidationResult externalResult = validateExternal(testServer, testPort, timeoutMs);
        if (externalResult != ValidationResult.OK) {
            Log.e(TAG, "External validation failed: " + externalResult);
            return false;
        }

        Log.i(TAG, "Connection validation: OK");
        return true;
    }
}
