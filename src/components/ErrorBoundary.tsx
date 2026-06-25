/**
 * ErrorBoundary — React компонент для перехвата ошибок
 * Решает проблему: Необработанные ошибки ломают весь UI
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error details
    console.error('[ErrorBoundary] Error caught:', error);
    console.error('[ErrorBoundary] Error info:', errorInfo);

    // Update state
    this.setState({
      error,
      errorInfo,
    });

    // Call custom handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Try to notify native if available
    if ((window as any).SimProxyBridge?.showNotification) {
      try {
        (window as any).SimProxyBridge.showNotification(
          'Sim Proxy Error',
          'An unexpected error occurred. Please restart the app.'
        );
      } catch (e) {
        console.error('[ErrorBoundary] Failed to notify native:', e);
      }
    }
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      // Custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-red-900 p-4">
          <div className="bg-red-800 rounded-lg p-6 max-w-md w-full">
            <h1 className="text-2xl font-bold text-white mb-4">Oops! Something went wrong</h1>

            <p className="text-red-100 mb-4">
              An unexpected error occurred. Please try restarting the app.
            </p>

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="bg-red-950 p-3 rounded text-sm text-red-100 mb-4 overflow-auto max-h-32">
                <summary className="cursor-pointer font-semibold mb-2">
                  Error Details (Dev Only)
                </summary>
                <pre className="whitespace-pre-wrap break-words">
                  {this.state.error.toString()}
                  {'\n\n'}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <button
              onClick={this.handleReset}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded transition"
            >
              Try Again
            </button>

            <button
              onClick={() => window.location.reload()}
              className="w-full mt-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 rounded transition"
            >
              Restart App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Hook version of ErrorBoundary for easier integration
 */
export function useErrorHandler(onError?: (error: Error) => void) {
  return (error: Error | null) => {
    if (error) {
      console.error('[useErrorHandler] Error:', error);
      onError?.(error);
      throw error;
    }
  };
}

