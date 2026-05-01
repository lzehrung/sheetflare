type NoticeBannerProps = {
  tone: 'idle' | 'loading' | 'success' | 'error';
  message: string | null;
};

export function NoticeBanner({ tone, message }: NoticeBannerProps) {
  if (tone === 'idle' || !message) {
    return null;
  }

  let className = 'muted';
  if (tone === 'error') {
    className = 'error';
  } else if (tone === 'success') {
    className = 'success';
  }

  return (
    <p
      className={className}
      role="status"
      aria-live="polite"
    >
      {message}
    </p>
  );
}
