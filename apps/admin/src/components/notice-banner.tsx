type NoticeBannerProps = {
  tone: 'idle' | 'loading' | 'success' | 'error';
  message: string | null;
};

export function NoticeBanner({ tone, message }: NoticeBannerProps) {
  if (tone === 'idle' || !message) {
    return null;
  }

  return (
    <p
      className={tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'muted'}
      role="status"
      aria-live="polite"
    >
      {message}
    </p>
  );
}
