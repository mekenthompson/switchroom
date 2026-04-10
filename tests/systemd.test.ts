import { describe, it, expect } from "vitest";
import { generateUnit } from "../src/agents/systemd.js";

describe("generateUnit", () => {
  it("generates valid unit file content", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("sets the correct Description", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("Description=clerk agent: health-coach");
  });

  it("uses script -qfc for PTY provision", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
    expect(unit).toContain("/home/user/.clerk/agents/health-coach/start.sh");
  });

  it("logs to service.log in agent dir", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("/home/user/.clerk/agents/health-coach/service.log");
  });

  it("sets the correct WorkingDirectory", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("WorkingDirectory=/home/user/.clerk/agents/health-coach");
  });

  it("handles agent names with hyphens correctly", () => {
    const unit = generateUnit("my-cool-agent", "/agents/my-cool-agent");
    expect(unit).toContain("Description=clerk agent: my-cool-agent");
    expect(unit).toContain("/agents/my-cool-agent/start.sh");
    expect(unit).toContain("WorkingDirectory=/agents/my-cool-agent");
  });

  it("includes network dependency targets", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  it("configures restart on failure", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=15");
  });

  it("sets Type=simple for script-based execution", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Type=simple");
  });

  it("includes journal output", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
  });

  it("targets default.target for user units", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("uses expect autoaccept wrapper when useAutoaccept=true", () => {
    const unit = generateUnit("fork", "/tmp/fork", true);
    expect(unit).toContain("/usr/bin/expect");
    expect(unit).toContain("autoaccept.exp");
    expect(unit).toContain("/tmp/fork/start.sh");
    // Should NOT reference the old Python autoaccept script
    expect(unit).not.toContain("autoaccept.py");
    expect(unit).not.toContain("/usr/bin/python3");
  });

  it("does not use expect wrapper by default", () => {
    const unit = generateUnit("plain", "/tmp/plain", false);
    expect(unit).not.toContain("autoaccept.exp");
    expect(unit).not.toContain("/usr/bin/expect");
    expect(unit).toContain("/bin/bash");
  });
});
