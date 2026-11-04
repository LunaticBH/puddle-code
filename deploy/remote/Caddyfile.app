{
  admin off
  auto_https off
}
:8080 {
  root * /srv
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    Cache-Control no-store
  }
  @application not path /preview.html
  header @application {
    Permissions-Policy "camera=(self), microphone=(), geolocation=()"
    Content-Security-Policy "default-src 'none'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; media-src blob:; frame-src 'self' blob:; connect-src {$PUDDLE_REMOTE_SERVICE} {$PUDDLE_REMOTE_WSS}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
    X-Frame-Options DENY
  }
  @preview path /preview.html
  header @preview Permissions-Policy "camera=(), microphone=(), geolocation=()"
  header @preview Content-Security-Policy "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: https:; style-src 'unsafe-inline' data: https:; img-src data: https:; font-src data: https:; media-src data: https:; connect-src https:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
  # Worker/manifest requests must not fall back to application HTML.
  @notificationAssets path /notification-worker.js /manifest.webmanifest /puddle-app.png
  handle @notificationAssets {
    file_server
  }
  # Installer requests must never receive the SPA fallback (including typos).
  @installers path /install*.sh /install*.ps1
  handle @installers {
    header Content-Type "text/plain; charset=utf-8"
    file_server
  }
  handle {
    try_files {path} /index.html
    file_server
  }
}
