package com.simproxy.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * NetworkMonitor — отслеживает состояние сети устройства.
 * Обнаруживает:
 * - Изменения тип сети (WiFi/Mobile/Bluetooth и т.д.)
 * - Потерю сетевого подключения
 * - Изменение качества сети
 */
public class NetworkMonitor {
    private static final String TAG = "NetworkMonitor";
    private static volatile NetworkMonitor instance;
    private final ConnectivityManager connectivityManager;
    private final AtomicReference<NetworkType> currentNetwork = new AtomicReference<>(NetworkType.NONE);
    private final AtomicBoolean isMonitoring = new AtomicBoolean(false);
    private final List<NetworkChangeListener> listeners = new ArrayList<>();
    private ConnectivityManager.NetworkCallback networkCallback;

    public enum NetworkType {
        NONE, WIFI, MOBILE, ETHERNET, BLUETOOTH, UNKNOWN
    }

    public interface NetworkChangeListener {
        void onNetworkChanged(NetworkType oldType, NetworkType newType);
        void onNetworkLost();
        void onNetworkAvailable(NetworkType type);
    }

    private NetworkMonitor(Context context) {
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    public static NetworkMonitor getInstance(Context context) {
        if (instance == null) {
            synchronized (NetworkMonitor.class) {
                if (instance == null) {
                    instance = new NetworkMonitor(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    /**
     * Определяет тип сети из сетевых возможностей
     */
    private NetworkType getNetworkType(NetworkCapabilities caps) {
        if (caps == null) return NetworkType.NONE;

        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return NetworkType.WIFI;
        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return NetworkType.MOBILE;
        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return NetworkType.ETHERNET;
        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) {
            return NetworkType.BLUETOOTH;
        }
        return NetworkType.UNKNOWN;
    }

    /**
     * Начинает мониторинг сети
     */
    public void startMonitoring() {
        if (isMonitoring.getAndSet(true)) {
            return; // Already monitoring
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                    .build();

            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    super.onAvailable(network);
                    NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(network);
                    NetworkType newType = getNetworkType(caps);

                    NetworkType oldType = currentNetwork.getAndSet(newType);
                    Log.d(TAG, "Network available: " + newType);

                    notifyListeners(listener -> {
                        if (!oldType.equals(newType) && !oldType.equals(NetworkType.NONE)) {
                            listener.onNetworkChanged(oldType, newType);
                        } else {
                            listener.onNetworkAvailable(newType);
                        }
                    });
                }

                @Override
                public void onLost(Network network) {
                    super.onLost(network);
                    NetworkType oldType = currentNetwork.getAndSet(NetworkType.NONE);
                    Log.w(TAG, "Network lost: " + oldType);

                    notifyListeners(NetworkChangeListener::onNetworkLost);
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities networkCapabilities) {
                    super.onCapabilitiesChanged(network, networkCapabilities);
                    // Only react to the primary (default) network. Android keeps mobile data
                    // alive as a secondary network while WiFi is active; onCapabilitiesChanged
                    // fires for BOTH, flipping currentNetwork WIFI↔MOBILE on every capability
                    // event and causing spurious onNetworkChanged → reconnect storms.
                    Network activeNet = connectivityManager.getActiveNetwork();
                    if (activeNet == null || !activeNet.equals(network)) return;

                    NetworkType newType = getNetworkType(networkCapabilities);
                    NetworkType oldType = currentNetwork.getAndSet(newType);

                    if (!oldType.equals(newType)) {
                        Log.d(TAG, "Network capabilities changed: " + oldType + " -> " + newType);
                        notifyListeners(listener -> listener.onNetworkChanged(oldType, newType));
                    }
                }
            };

            connectivityManager.registerNetworkCallback(request, networkCallback);
            Log.d(TAG, "Network monitoring started");
        }
    }

    /**
     * Останавливает мониторинг сети
     */
    public void stopMonitoring() {
        if (!isMonitoring.getAndSet(false)) {
            return; // Not monitoring
        }

        if (networkCallback != null && connectivityManager != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
                networkCallback = null;
                Log.d(TAG, "Network monitoring stopped");
            } catch (Exception e) {
                Log.e(TAG, "Error stopping network monitoring", e);
            }
        }
    }

    /**
     * Получает текущий тип сети
     */
    public NetworkType getCurrentNetwork() {
        return currentNetwork.get();
    }

    /**
     * Проверяет есть ли интернет
     */
    public boolean isNetworkAvailable() {
        NetworkType type = getCurrentNetwork();
        return !type.equals(NetworkType.NONE);
    }

    /**
     * Проверяет подключено ли по WiFi
     */
    public boolean isWifiConnected() {
        return getCurrentNetwork().equals(NetworkType.WIFI);
    }

    /**
     * Проверяет подключено ли по мобильной сети
     */
    public boolean isMobileConnected() {
        return getCurrentNetwork().equals(NetworkType.MOBILE);
    }

    /**
     * Добавляет слушателя изменений сети
     */
    public void addListener(NetworkChangeListener listener) {
        synchronized (listeners) {
            listeners.add(listener);
        }
    }

    /**
     * Удаляет слушателя
     */
    public void removeListener(NetworkChangeListener listener) {
        synchronized (listeners) {
            listeners.remove(listener);
        }
    }

    /**
     * Уведомляет всех слушателей
     */
    private void notifyListeners(ListenerAction action) {
        // Копируем список перед итерацией: если колбэк вызовет add/removeListener из
        // другого потока, не будет deadlock на synchronized(listeners).
        final java.util.List<NetworkChangeListener> snapshot;
        synchronized (listeners) {
            snapshot = new java.util.ArrayList<>(listeners);
        }
        for (NetworkChangeListener listener : snapshot) {
            try {
                action.execute(listener);
            } catch (Throwable e) {
                Log.e(TAG, "Error notifying listener", e);
            }
        }
    }

    @FunctionalInterface
    private interface ListenerAction {
        void execute(NetworkChangeListener listener);
    }

    /**
     * Получает подробную информацию о текущей сети
     */
    public String getNetworkInfo() {
        NetworkType type = getCurrentNetwork();
        String typeStr = type.name();

        if (connectivityManager != null) {
            Network network = connectivityManager.getActiveNetwork();
            if (network != null) {
                NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(network);
                if (caps != null) {
                    StringBuilder sb = new StringBuilder();
                    sb.append(typeStr).append(" | ");
                    sb.append("Internet: ").append(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ? "YES" : "NO");
                    sb.append(" | Validated: ").append(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ? "YES" : "NO");

                    return sb.toString();
                }
            }
        }

        return typeStr;
    }

}

