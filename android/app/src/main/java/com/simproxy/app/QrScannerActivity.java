package com.simproxy.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class QrScannerActivity extends AppCompatActivity {
    private static final String TAG = "QrScanner";
    private ExecutorService cameraExecutor;
    private PreviewView previewView;
    private BarcodeScanner scanner;
    private boolean isScanning = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Programmatic UI
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        
        previewView = new PreviewView(this);
        previewView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(previewView);

        // Overlay with scanning frame
        View overlay = new View(this);
        overlay.setBackgroundColor(Color.parseColor("#80000000")); // Semi-transparent black
        // This is a bit complex for programmatic UI without drawing, so let's just add a simple border
        root.addView(overlay);

        // Back button
        ImageButton backBtn = new ImageButton(this);
        backBtn.setImageResource(android.R.drawable.ic_menu_revert);
        backBtn.setBackgroundColor(Color.TRANSPARENT);
        FrameLayout.LayoutParams backParams = new FrameLayout.LayoutParams(120, 120);
        backParams.setMargins(40, 40, 0, 0);
        backBtn.setLayoutParams(backParams);
        backBtn.setOnClickListener(v -> finish());
        root.addView(backBtn);

        // Кнопка выбора QR из галереи (справа сверху)
        TextView galleryBtn = new TextView(this);
        galleryBtn.setText("🖼  Галерея");
        galleryBtn.setTextColor(Color.WHITE);
        galleryBtn.setTextSize(14);
        galleryBtn.setBackgroundColor(Color.parseColor("#40000000"));
        galleryBtn.setPadding(28, 16, 28, 16);
        FrameLayout.LayoutParams galParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        galParams.gravity = Gravity.TOP | Gravity.END;
        galParams.setMargins(0, 48, 40, 0);
        galleryBtn.setLayoutParams(galParams);
        galleryBtn.setOnClickListener(v -> openGallery());
        root.addView(galleryBtn);

        TextView hint = new TextView(this);
        hint.setText("Наведите камеру на QR-код или выберите из галереи");
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(16);
        hint.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams hintParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintParams.gravity = Gravity.BOTTOM;
        hintParams.setMargins(0, 0, 0, 100);
        hint.setLayoutParams(hintParams);
        root.addView(hint);

        setContentView(root);

        cameraExecutor = Executors.newSingleThreadExecutor();
        
        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
        scanner = BarcodeScanning.getClient(options);

        // Камера требует рантайм-разрешения (Android 6+). Без него превью не
        // открывается — раньше сканер показывал чёрный экран. Запрашиваем явно;
        // выбор QR из галереи работает и без разрешения камеры.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.CAMERA }, REQ_CAMERA);
        }
    }

    private static final int REQ_CAMERA = 7002;

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                Toast.makeText(this, "Нет доступа к камере. Выберите QR из галереи.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = ProcessCameraProvider.getInstance(this);

        cameraProviderFuture.addListener(() -> {
            try {
                ProcessCameraProvider cameraProvider = cameraProviderFuture.get();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                        .setTargetResolution(new Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();

                imageAnalysis.setAnalyzer(cameraExecutor, image -> {
                    if (!isScanning) {
                        image.close();
                        return;
                    }
                    processImage(image);
                });

                CameraSelector cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, cameraSelector, preview, imageAnalysis);

            } catch (Throwable e) {
                Log.e(TAG, "Use case binding failed", e);
                Toast.makeText(this, "Не удалось открыть камеру. Выберите QR из галереи.", Toast.LENGTH_LONG).show();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @SuppressLint("UnsafeOptInUsageError")
    private void processImage(androidx.camera.core.ImageProxy imageProxy) {
        if (imageProxy.getImage() == null) {
            imageProxy.close();
            return;
        }

        InputImage image = InputImage.fromMediaImage(imageProxy.getImage(), imageProxy.getImageInfo().getRotationDegrees());

        scanner.process(image)
                .addOnSuccessListener(barcodes -> {
                    for (Barcode barcode : barcodes) {
                        String rawValue = barcode.getRawValue();
                        if (rawValue != null && isScanning) {
                            isScanning = false;
                            onQrCodeScanned(rawValue);
                            break;
                        }
                    }
                })
                .addOnFailureListener(e -> Log.e(TAG, "Barcode scanning failed", e))
                .addOnCompleteListener(task -> imageProxy.close());
    }

    private static final int REQ_PICK_IMAGE = 7001;

    private void openGallery() {
        try {
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.setType("image/*");
            startActivityForResult(Intent.createChooser(intent, "Выберите QR-код"), REQ_PICK_IMAGE);
        } catch (Exception e) {
            Log.e(TAG, "openGallery failed", e);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_IMAGE && resultCode == RESULT_OK && data != null && data.getData() != null) {
            scanFromUri(data.getData());
        }
    }

    private void scanFromUri(Uri uri) {
        try {
            InputImage image = InputImage.fromFilePath(this, uri);
            isScanning = false; // приостанавливаем камеру, чтобы не было гонки
            scanner.process(image)
                    .addOnSuccessListener(barcodes -> {
                        for (Barcode barcode : barcodes) {
                            String rawValue = barcode.getRawValue();
                            if (rawValue != null) {
                                onQrCodeScanned(rawValue);
                                return;
                            }
                        }
                        // Ничего не нашли — возобновляем камеру
                        runOnUiThread(() -> {
                            isScanning = true;
                            android.widget.Toast.makeText(this, "QR-код не найден на изображении", android.widget.Toast.LENGTH_SHORT).show();
                        });
                    })
                    .addOnFailureListener(e -> {
                        Log.e(TAG, "Gallery scan failed", e);
                        isScanning = true;
                    });
        } catch (Exception e) {
            Log.e(TAG, "scanFromUri failed", e);
            isScanning = true;
        }
    }

    private void onQrCodeScanned(String result) {
        Intent data = new Intent();
        data.putExtra("SCAN_RESULT", result);
        setResult(RESULT_OK, data);
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        isScanning = false;
        cameraExecutor.shutdownNow();
        scanner.close();
    }
}
