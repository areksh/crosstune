/**
 * Ready-to-install snippets that call `qobuz-helper run-due` every 15 minutes
 * from the OS scheduler (`qobuz-helper schedule print`). Nothing is installed
 * automatically. `run-due` only does something when a job is due, so a short
 * interval costs nothing and catches up soon after a machine wakes.
 */

export type ScheduleTarget = "cron" | "systemd" | "launchd" | "windows";

export interface SchedulePaths {
  node: string;
  script: string;
  logFile: string;
}

export function scheduleSnippet(target: ScheduleTarget, paths: SchedulePaths): string {
  const { node, script, logFile } = paths;
  switch (target) {
    case "cron":
      return [
        "# Add this line with `crontab -e`:",
        `*/15 * * * * "${node}" "${script}" run-due >> "${logFile}" 2>&1`,
      ].join("\n");
    case "systemd":
      return [
        "# ~/.config/systemd/user/qobuz-helper.service",
        "[Unit]",
        "Description=qobuz-helper: run the jobs that are due",
        "",
        "[Service]",
        "Type=oneshot",
        `ExecStart="${node}" "${script}" run-due`,
        "",
        "# ~/.config/systemd/user/qobuz-helper.timer",
        "[Unit]",
        "Description=Run qobuz-helper jobs every 15 minutes",
        "",
        "[Timer]",
        "OnCalendar=*:0/15",
        "Persistent=true",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
        "# Then: systemctl --user daemon-reload && systemctl --user enable --now qobuz-helper.timer",
        "# (and `loginctl enable-linger $USER` to run while you are logged out)",
      ].join("\n");
    case "launchd":
      return [
        "<!-- ~/Library/LaunchAgents/com.qobuz-helper.run-due.plist -->",
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key><string>com.qobuz-helper.run-due</string>",
        "  <key>ProgramArguments</key>",
        `  <array><string>${node}</string><string>${script}</string><string>run-due</string></array>`,
        "  <key>StartInterval</key><integer>900</integer>",
        "  <key>RunAtLoad</key><true/>",
        `  <key>StandardOutPath</key><string>${logFile}</string>`,
        `  <key>StandardErrorPath</key><string>${logFile}</string>`,
        "</dict>",
        "</plist>",
        "<!-- Then: launchctl load ~/Library/LaunchAgents/com.qobuz-helper.run-due.plist -->",
      ].join("\n");
    case "windows":
      return [
        "REM Run once in a command prompt:",
        `schtasks /Create /SC MINUTE /MO 15 /TN "qobuz-helper run-due" /TR "\\"${node}\\" \\"${script}\\" run-due"`,
      ].join("\n");
  }
}
