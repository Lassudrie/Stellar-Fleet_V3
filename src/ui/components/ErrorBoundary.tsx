import React from 'react';

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Fatal render error', { error, errorInfo });
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 p-6 text-center">
          <div className="max-w-md space-y-4">
            <h1 className="text-3xl font-black uppercase tracking-wide">Fatal error</h1>
            <p className="text-slate-300 text-sm leading-relaxed">
              An unrecoverable error occurred. Please reload the application. If the problem persists, check the console logs.
            </p>
            <button
              onClick={this.handleReload}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase tracking-widest rounded shadow-lg transition-colors"
            >
              Reload
            </button>
            {this.state.error && (
              <p className="text-xs text-slate-500 break-all">
                {this.state.error.message}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
