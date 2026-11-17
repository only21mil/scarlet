//! Run an ephemeral Codex edit over App Server stdio. `codex exec --json`
//! remains available when App Server cannot use Scarlet's isolated configuration.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::util::{env_get, home_dir};
use super::codex_app_server::run_app_server;
use super::detect::api_key_vars;
use super::runner::{cut_short, exit_error, report_usage, write_files, RunOptions, RunnerCommand};
use super::spawn::{resolve_cli, spawn_lines, SpawnLinesOptions};
use super::usage::{add_usage, codex_app_server_usage, codex_usage, AgentUsage};
use super::types::{brief, brief_input, is_question_tool, plan_event, tail_summary, truthy, value_text, McpSpec, PlanStep, RunResult, RunnerEvent};

#[derive(Debug, Default, Clone)]
pub struct CodexState {
    pub texts: Vec<String>,
    pub last_message: Option<String>,
    final_message: Option<String>,
    pub question: Option<String>,
    pub question_posted: bool,
    pub should_stop: bool,
    pub failed: Option<String>,
    /// The latest reconnect notice. Codex recovers from most, so it fails the run only if nothing else explains a failure.
    pub retry_notice: Option<String>,
    pub turn_completed: bool,
    pub usage: Option<AgentUsage>,
    turn_requested: bool,
    model: Option<String>,
    /// The plan last passed on, so one Codex repeats isn't sent twice.
    pub plan: Option<Vec<PlanStep>>,
}

/// The steps of a `todo_list` item: Codex's `update_plan`, as `codex exec --json` reports it. Each step is its text and
/// whether it is finished. The stream leaves out which step is under way, so none is "in_progress".
pub fn codex_plan(items: Option<&Value>) -> Option<Vec<PlanStep>> {
    let steps = items?.as_array()?.iter().filter_map(|entry| {
        let text = entry.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())?;
        let done = entry.get("completed").and_then(Value::as_bool).unwrap_or(false);
        Some(PlanStep { text: text.to_string(), state: if done { "done" } else { "pending" } })
    });
    Some(steps.collect())
}

/// Codex reports stream retries and its HTTPS fallback as errors, then usually carries on.
pub fn is_retry_notice(text: &str) -> bool {
    let reconnecting = text.strip_prefix("Reconnecting... ").and_then(|rest| rest.split_once('/')).is_some_and(|(done, rest)| {
        !done.is_empty() && done.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(|c: char| c.is_ascii_digit())
    });
    reconnecting || text.starts_with("Falling back from WebSockets")
}

fn s(v: Option<&Value>) -> Option<String> {
    v.filter(|x| !x.is_null()).map(value_text)
}

fn record_codex_plan(steps: Option<Vec<PlanStep>>, st: &mut CodexState, events: &mut Vec<RunnerEvent>) {
    if let Some(steps) = steps.filter(|steps| st.plan.as_ref() != Some(steps)) {
        events.push(plan_event(&steps));
        st.plan = Some(steps);
    }
}

/// Parse one JSONL line from `codex exec --json`.
pub fn parse_codex_line(line: &str, st: &mut CodexState) -> Vec<RunnerEvent> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v @ Value::Object(_)) => v,
        _ => return vec![RunnerEvent::new("log", line)],
    };
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    codex_events(kind, &msg, st)
}

fn codex_events(kind: &str, msg: &Value, st: &mut CodexState) -> Vec<RunnerEvent> {
    let mut events = Vec::new();
    let item = msg.get("item").filter(|i| i.is_object());

    match kind {
        "thread.started" => {
            let tid = msg.get("thread_id").or_else(|| msg.pointer("/thread/id")).filter(|v| !v.is_null());
            let text = format!("Codex session started{}", tid.map(|t| format!(" ({})", value_text(t))).unwrap_or_default());
            let mut data = serde_json::Map::new();
            data.insert("kind".into(), json!("init"));
            if let Some(t) = tid {
                data.insert("threadId".into(), t.clone());
            }
            events.push(RunnerEvent::with("log", text, Value::Object(data)));
        }
        "turn.started" => {}
        "item.started" | "item.updated" | "item.completed" => {
            let Some(item) = item else { return events };
            let completed = kind == "item.completed";
            let started = kind == "item.started";
            let itype = item.get("type").and_then(Value::as_str).unwrap_or("");
            let text_field = item.get("text").and_then(Value::as_str).map(str::to_string);
            match itype {
                "agent_message" | "agentMessage" => {
                    if completed {
                        if let Some(t) = text_field.filter(|t| !t.trim().is_empty()) {
                            st.texts.push(t.clone());
                            st.last_message = Some(t.clone());
                            if item["phase"] == "final_answer" {
                                st.final_message = Some(t.clone());
                            }
                            events.push(RunnerEvent::new("log", t));
                        }
                    }
                }
                "reasoning" => {
                    if completed {
                        let summary = || item.get("summary")?.as_array().map(|parts| {
                            parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
                        });
                        if let Some(t) = text_field.or_else(summary).filter(|t| !t.trim().is_empty()) {
                            events.push(RunnerEvent::with("log", format!("(thinking) {}", brief_input(Some(&Value::String(t)), 200)), json!({"kind":"reasoning"})));
                        }
                    }
                }
                "command_execution" | "commandExecution" => {
                    let command = item.get("command");
                    if started {
                        let mut data = serde_json::Map::new();
                        data.insert("tool".into(), json!("command_execution"));
                        if let Some(c) = command {
                            data.insert("command".into(), c.clone());
                        }
                        events.push(RunnerEvent::with("tool", format!("shell {}", brief_input(command, 200)), Value::Object(data)));
                    } else if completed {
                        if let Some(code) = item.get("exit_code").or_else(|| item.get("exitCode")).and_then(Value::as_i64) {
                            if code != 0 {
                                events.push(RunnerEvent::new(
                                    "error",
                                    format!("Command exited {code}: {}\n{}", brief_input(command, 120), brief_input(item.get("aggregated_output").or_else(|| item.get("aggregatedOutput")), 400)),
                                ));
                            }
                        }
                    }
                }
                "mcp_tool_call" | "mcpToolCall" => {
                    let server = s(item.get("server")).unwrap_or_else(|| "mcp".into());
                    let tool = s(item.get("tool"));
                    let name = format!("{server}.{}", tool.clone().unwrap_or_else(|| "?".into()));
                    let arguments = item.get("arguments");
                    let status = item.get("status").and_then(Value::as_str);
                    let has_error = truthy(item.get("error"));
                    if is_question_tool(tool.as_deref()) {
                        let question_text = arguments.and_then(|a| a.get("text")).and_then(Value::as_str).filter(|text| !text.trim().is_empty());
                        // App Server may withhold the arguments until the tool finishes.
                        let has_question = question_text.is_some() || itype == "mcp_tool_call";
                        if st.question.is_none() && has_question && (started || completed) {
                            let text = question_text.map(str::to_string).unwrap_or_else(|| brief(arguments));
                            st.question = Some(text.clone());
                            let mut data = serde_json::Map::new();
                            data.insert("tool".into(), Value::String(name.clone()));
                            if let Some(id) = item.get("id") {
                                data.insert("itemId".into(), id.clone());
                            }
                            events.push(RunnerEvent::with("question", text, Value::Object(data)));
                        }
                        if completed {
                            st.question_posted = status != Some("failed") && !has_error && !truthy(item.pointer("/result/isError"));
                            st.should_stop = st.question.is_some();
                        }
                    } else if started {
                        let text = format!("{name} {}", brief(arguments)).trim().to_string();
                        let mut data = serde_json::Map::new();
                        data.insert("tool".into(), Value::String(name));
                        data.insert("input".into(), arguments.cloned().unwrap_or(Value::Null));
                        if let Some(id) = item.get("id") {
                            data.insert("itemId".into(), id.clone());
                        }
                        data.retain(|_, v| !v.is_null());
                        events.push(RunnerEvent::with("tool", text, Value::Object(data)));
                    } else if completed && (status == Some("failed") || has_error) {
                        let detail = if has_error { item.get("error") } else { item.get("result") };
                        events.push(RunnerEvent::new("error", format!("{name} failed: {}", brief_input(detail, 400))));
                    }
                }
                "file_change" | "fileChange" => {
                    if completed {
                        events.push(RunnerEvent::with("tool", format!("edited files {}", brief_input(item.get("changes"), 200)), json!({"tool":"file_change"})));
                    }
                }
                "web_search" | "webSearch" => {
                    if started {
                        events.push(RunnerEvent::with("tool", format!("web search {}", brief_input(item.get("query"), 120)), json!({"tool":"web_search"})));
                    }
                }
                "todo_list" => {
                    // The whole plan each time: when the model first makes it, on every update, and once more as the turn ends.
                    record_codex_plan(codex_plan(item.get("items")), st, &mut events);
                }
                "error" => {
                    let text = item.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| brief_input(Some(item), 400));
                    if is_retry_notice(&text) {
                        events.push(RunnerEvent::with("log", text, json!({"kind":"connection"})));
                    } else {
                        events.push(RunnerEvent::new("error", text));
                    }
                }
                _ => {}
            }
        }
        "turn.completed" => {
            st.turn_completed = true;
            st.usage = add_usage(st.usage.take(), codex_usage(msg.get("usage"), None));
            let mut data = serde_json::Map::new();
            if let Some(u) = msg.get("usage") {
                data.insert("usage".into(), u.clone());
            }
            let summary = st.final_message.as_ref().or(st.last_message.as_ref()).cloned().unwrap_or_else(|| "done".into());
            events.push(RunnerEvent::with("result", summary, Value::Object(data)));
        }
        "turn.failed" => {
            let err = msg
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let b = brief_input(msg.get("error"), 400);
                    if b.is_empty() {
                        "turn failed".into()
                    } else {
                        b
                    }
                });
            st.failed = Some(err.clone());
            events.push(RunnerEvent::new("error", err));
        }
        "error" => {
            let err = msg.get("message").or_else(|| msg.pointer("/error/message")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| brief_input(Some(msg), 400));
            if msg["willRetry"] == true || is_retry_notice(&err) {
                st.retry_notice = Some(err.clone());
                events.push(RunnerEvent::with("log", err, json!({"kind":"connection"})));
            } else {
                st.failed = Some(err.clone());
                events.push(RunnerEvent::new("error", err));
            }
        }
        _ => {}
    }
    events
}

fn app_server_events(method: &str, params: &Value, st: &mut CodexState) -> Vec<RunnerEvent> {
    match method {
        "thread/started" => {
            st.model = params["model"].as_str().map(str::to_string);
            codex_events("thread.started", params, st)
        }
        "turn/requested" => {
            st.turn_requested = true;
            Vec::new()
        }
        "thread/tokenUsage/updated" => {
            if let Some(usage) = codex_app_server_usage(params.pointer("/tokenUsage/total"), st.model.as_deref()) {
                st.usage = Some(usage);
            }
            Vec::new()
        }
        "turn/plan/updated" => {
            let mut events = Vec::new();
            let steps = params["plan"].as_array().map(|plan| plan.iter().filter_map(|entry| {
                let text = entry["step"].as_str()?.trim();
                let state = match entry["status"].as_str() {
                    Some("completed") => "done",
                    Some("inProgress") => "in_progress",
                    _ => "pending",
                };
                (!text.is_empty()).then(|| PlanStep { text: text.into(), state })
            }).collect());
            record_codex_plan(steps, st, &mut events);
            events
        }
        "item/started" => codex_events("item.started", params, st),
        "item/updated" => codex_events("item.updated", params, st),
        "item/completed" => codex_events("item.completed", params, st),
        "turn/completed" => match params["turn"]["status"].as_str() {
            Some("completed") => codex_events("turn.completed", &Value::Null, st),
            Some("interrupted") if st.question.is_some() => Vec::new(),
            Some("interrupted") => codex_events("turn.failed", &json!({ "error": { "message": "Codex interrupted the turn" } }), st),
            _ => codex_events("turn.failed", &params["turn"], st),
        },
        "error" => codex_events("error", params, st),
        _ => Vec::new(),
    }
}

/// TOML basic string.
pub fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t"))
}

pub struct CodexCommand {
    pub cmd: RunnerCommand,
    pub last_message_path: std::path::PathBuf,
}

// Seatbelt re-executes Codex to load AGENTS.md. Launch the real file and
// grant only that file, since a Homebrew symlink is not covered by the grant.
fn codex_executable(bin: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    return std::fs::canonicalize(bin).ok().map(|path| path.to_string_lossy().into_owned());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bin;
        None
    }
}

fn codex_tool_args(mcp: &McpSpec, executable: Option<&str>) -> Vec<String> {
    let executable_read = executable.map(|path| format!(",{}=\"read\"", toml_string(path))).unwrap_or_default();
    // Forward slashes keep the TOML readable and work for node on Windows.
    let to_toml = |p: &str| p.replace('\\', "/");
    let mut args = Vec::new();
    // The legacy Windows sandboxes cannot enforce this profile's denied root reads.
    #[cfg(windows)]
    args.extend(["-c".into(), r#"windows.sandbox="mxc""#.into()]);
    for feature in ["shell_tool", "view_image", "computer_use", "multi_agent", "plugins", "apps", "hooks"] {
        args.extend(["--disable".into(), feature.into()]);
    }
    args.extend([
        "-c".into(), r#"approval_policy="never""#.into(),
        "-c".into(), r#"web_search="disabled""#.into(),
        // Long edit prompts include the timeline, editor's notes and earlier answers.
        "-c".into(), "project_doc_max_bytes=4194304".into(),
        "-c".into(), r#"default_permissions="scarlet""#.into(),
        "-c".into(), format!(r#"permissions.scarlet.filesystem={{":root"="deny",":minimal"="read",":workspace_roots"={{"."="write"}}{executable_read}}}"#),
        "-c".into(), "permissions.scarlet.network.enabled=false".into(),
        "-c".into(), r#"mcp_servers.scarlet.default_tools_approval_mode="approve""#.into(),
        "-c".into(), "mcp_servers.scarlet.required=true".into(),
        "-c".into(), "mcp_servers.scarlet.startup_timeout_sec=60".into(),
        // Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured.
        "-c".into(), "mcp_servers.scarlet.tool_timeout_sec=300".into(),
        "-c".into(),
        format!("mcp_servers.scarlet.command={}", toml_string(&to_toml(&mcp.command))),
        "-c".into(),
        format!("mcp_servers.scarlet.args=[{}]", mcp.args.iter().map(|a| toml_string(&to_toml(a))).collect::<Vec<_>>().join(",")),
        "-c".into(),
        format!("mcp_servers.scarlet.env_vars=[{}]", mcp.env.keys().map(|k| toml_string(k)).collect::<Vec<_>>().join(",")),
        "-c".into(),
        r#"shell_environment_policy.exclude=["SCARLET_*"]"#.into(),
    ]);
    args
}

#[allow(clippy::too_many_arguments)]
pub fn build_codex_command(model: Option<&str>, effort: Option<&str>, service_tier: Option<&str>, system_prompt: &str, instruction: &str, plan: bool, mcp: &McpSpec, cwd: &Path, bin: &str, tmp_dir: &Path) -> CodexCommand {
    let last_message_path = tmp_dir.join("last-message.md");
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--json".into(),
        "--skip-git-repo-check".into(),
        "--cd".into(),
        cwd.to_string_lossy().to_string(),
        "--strict-config".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "--ephemeral".into(),
    ];
    let executable = codex_executable(bin);
    args.extend(codex_tool_args(mcp, executable.as_deref()));
    args.extend([
        "--output-last-message".into(),
        last_message_path.to_string_lossy().to_string(),
    ]);
    // Codex's own to-do tool, which it reports as `todo_list` items. A Codex without this key refuses it under --strict-config.
    if plan {
        args.extend(["-c".into(), "tools.update_plan.enabled=true".into()]);
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort={}", toml_string(e)));
    }
    if let Some(tier) = service_tier {
        args.push("-c".into());
        args.push(format!("service_tier={}", toml_string(tier)));
    }
    args.push("-".to_string());
    let mut files = BTreeMap::new();
    files.insert(cwd.join("AGENTS.md"), system_prompt.to_string());
    CodexCommand { cmd: RunnerCommand { file: executable.unwrap_or_else(|| bin.into()), args, stdin: Some(instruction.to_string()), files }, last_message_path }
}

fn app_server_args(opts: &RunOptions, executable: Option<&str>) -> Vec<String> {
    let mut args = vec!["app-server".into(), "--strict-config".into()];
    args.extend(codex_tool_args(&opts.mcp, executable));
    args.extend([
        "--disable".into(), "goals".into(),
        "-c".into(), "project_root_markers=[]".into(),
        "-c".into(), r#"cli_auth_credentials_store="file""#.into(),
        "-c".into(), "tools.experimental_request_user_input.enabled=false".into(),
        "-c".into(), format!("tools.update_plan.enabled={}", opts.plan),
    ]);
    if let Some(effort) = &opts.effort {
        args.extend(["-c".into(), format!("model_reasoning_effort={}", toml_string(effort))]);
    }
    args
}

/// App Server reads user configuration from CODEX_HOME. Give it a private directory
/// with the existing login and its write lock linked so Codex still owns token refreshes.
fn isolated_codex_home(opts: &RunOptions) -> std::result::Result<tempfile::TempDir, &'static str> {
    if api_key_vars("codex").iter().any(|key| env_get(&opts.env, key).is_some_and(|value| !value.is_empty())) {
        return Err("api_key");
    }
    // A task must not be able to supply its own App Server configuration or MCP servers.
    match std::fs::symlink_metadata(opts.cwd.join(".codex")) {
        Ok(_) => return Err("project_config"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("isolation_unavailable"),
    }
    let codex_home = env_get(&opts.env, "CODEX_HOME").filter(|home| !home.is_empty()).map(std::path::PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"));
    let codex_home = opts.cwd.join(codex_home).canonicalize().map_err(|_| "home_unavailable")?;
    let auth = codex_home.join("auth.json");
    let metadata = auth.metadata().map_err(|_| "auth_unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 { return Err("auth_unavailable"); }
    let home = tempfile::Builder::new().prefix("scarlet-codex-").tempdir().map_err(|_| "isolation_unavailable")?;
    crate::config::private_directory(home.path()).map_err(|_| "isolation_unavailable")?;
    #[cfg(unix)]
    use std::os::unix::fs::symlink as link_file;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_file as link_file;
    link_file(auth, home.path().join("auth.json")).map_err(|_| "isolation_unavailable")?;
    link_file(codex_home.join("auth.lock"), home.path().join("auth.lock")).map_err(|_| "isolation_unavailable")?;
    Ok(home)
}

async fn try_app_server(opts: &RunOptions, bin: &str, home: &Path) -> Option<RunResult> {
    let mut spawn = spawn_options(opts, None);
    spawn.env.retain(|key, _| !["CODEX_HOME", "CODEX_SQLITE_HOME"].iter().any(|name| key.eq_ignore_ascii_case(name)));
    spawn.env.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
    // The child already starts in the task directory. Passing cwd explicitly on thread/start
    // can make Codex trust a project and load its local configuration.
    let thread = json!({ "model": opts.model, "serviceTier": opts.service_tier });
    let turn = json!({ "input": [{ "type": "text", "text": opts.instruction, "text_elements": [] }] });
    let st = Arc::new(Mutex::new(CodexState::default()));
    let live_state = st.clone();
    let (on_event, on_usage) = (opts.on_event.clone(), opts.on_usage.clone());
    let requested_model = opts.model.clone();
    let show_plan = opts.plan;
    let mut sent_usage = None;
    let executable = codex_executable(bin);
    let outcome = run_app_server(executable.as_deref().unwrap_or(bin), &app_server_args(opts, executable.as_deref()), spawn, thread, turn, Box::new(move |method, params| {
        let mut state = live_state.lock().unwrap();
        for event in app_server_events(method, params, &mut state) {
            if show_plan || event.kind != "plan" { on_event(event); }
        }
        report_usage(&on_usage, &mut sent_usage, state.usage.clone().map(|usage| usage.or_model(requested_model.as_deref())));
        std::mem::take(&mut state.should_stop)
    })).await;
    let mut state = std::mem::take(&mut *st.lock().unwrap());
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) if !state.turn_requested && !opts.cancel.is_cancelled() => {
            log_fallback(opts, super::codex_app_server::fallback_reason(&error));
            return None;
        }
        Err(error) => {
            if state.failed.is_none() { state.failed = Some(format!("{error:#}")); }
            super::spawn::SpawnOutcome { aborted: opts.cancel.is_cancelled(), ..Default::default() }
        }
    };
    let last = state.final_message.take().or_else(|| state.last_message.take());
    Some(codex_result(state, opts.model.as_deref(), &outcome, last, false))
}

fn log_fallback(opts: &RunOptions, reason: &str) {
    let task = opts.task.as_deref().unwrap_or("none");
    let attempt = opts.mcp.env.get("SCARLET_TASK_STARTED_AT").map(String::as_str).unwrap_or("unknown");
    let level = if reason == "api_key" { log::Level::Info } else { log::Level::Warn };
    log::log!(level, "[host] codex-fallback task={task} attempt={attempt} reason={reason}");
}

fn spawn_options(opts: &RunOptions, stdin: Option<String>) -> SpawnLinesOptions {
    SpawnLinesOptions { cwd: opts.cwd.clone(), env: opts.env.clone(), stdin, cancel: opts.cancel.clone(), timeout: opts.timeout, stall: opts.stall, task: opts.task.clone() }
}

pub async fn run_codex(mut opts: RunOptions) -> RunResult {
    opts.env.extend(opts.mcp.env.clone());
    let bin = match opts.bin.clone().map(Ok).unwrap_or_else(|| resolve_cli("codex", &opts.env)) {
        Ok(b) => b,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let tmp_dir = opts.cwd.join(".scarlet");
    let _ = tokio::fs::create_dir_all(&tmp_dir).await;
    let built = build_codex_command(opts.model.as_deref(), opts.effort.as_deref(), opts.service_tier.as_deref(), &opts.system_prompt, &opts.instruction, opts.plan, &opts.mcp, &opts.cwd, &bin, &tmp_dir);
    if let Err(e) = write_files(&built.cmd.files).await {
        return RunResult::failed(e.to_string());
    }
    match isolated_codex_home(&opts) {
        Ok(home) => {
            if let Some(result) = try_app_server(&opts, &bin, home.path()).await {
                return result;
            }
        }
        Err(reason) => log_fallback(&opts, reason),
    }
    let st = Arc::new(Mutex::new(CodexState::default()));
    let st2 = st.clone();
    let on_event = opts.on_event.clone();
    let on_usage = opts.on_usage.clone();
    let mut sent_usage = None;
    let handler = Box::new(move |line: &str| -> bool {
        let mut s = st2.lock().unwrap();
        for ev in parse_codex_line(line, &mut s) {
            on_event(ev);
        }
        report_usage(&on_usage, &mut sent_usage, s.usage.clone());
        std::mem::take(&mut s.should_stop)
    });
    let outcome = match spawn_lines(
        &built.cmd.file,
        &built.cmd.args,
        spawn_options(&opts, built.cmd.stdin),
        handler,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let s = st.lock().unwrap().clone();
    let mut last = s.last_message.clone();
    if let Ok(from_file) = tokio::fs::read_to_string(&built.last_message_path).await {
        let t = from_file.trim();
        if !t.is_empty() {
            last = Some(t.to_string());
        }
    }
    codex_result(s, opts.model.as_deref(), &outcome, last, true)
}

fn codex_result(s: CodexState, model: Option<&str>, outcome: &super::spawn::SpawnOutcome, last: Option<String>, allow_clean_exit: bool) -> RunResult {
    let usage = s.usage.map(|usage| usage.or_model(model));
    if let Some(result) = cut_short(&s.texts, s.question.as_ref(), s.question_posted, outcome, &RunResult { usage: usage.clone(), ..Default::default() }) {
        return result;
    }
    let ok = s.failed.is_none() && (s.turn_completed || (allow_clean_exit && outcome.code == Some(0)));
    RunResult {
        ok,
        summary: last.unwrap_or_else(|| tail_summary(&s.texts)),
        error: if ok {
            None
        } else {
            Some(s.failed.clone().or_else(|| s.retry_notice.clone()).unwrap_or_else(|| exit_error("codex", outcome)))
        },
        exit_code: outcome.code,
        usage,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str], st: &mut CodexState) -> Vec<RunnerEvent> {
        lines.iter().flat_map(|l| parse_codex_line(l, st)).collect()
    }

    fn mcp() -> McpSpec {
        let mut env = BTreeMap::new();
        env.insert("SCARLET_SERVER".to_string(), "http://localhost:4000".to_string());
        env.insert("SCARLET_TOKEN".to_string(), "a\"b".to_string());
        McpSpec { command: "C:\\Program Files\\nodejs\\node.exe".into(), args: vec!["C:\\scarlet\\packages\\mcp\\dist\\cli.js".into()], env }
    }

    const FIXTURE: [&str; 9] = [
        r#"{"type":"thread.started","thread_id":"t_1"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"Need to read the transcript first."}}"#,
        r#"{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"completed","result":{"content":[]}}}"#,
        r#"{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"a\nb","exit_code":0,"status":"completed"}}"#,
        r#"{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Proposed the first cut as chg_2."}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
    ];

    #[test]
    fn maps_items_to_events_and_takes_the_last_agent_message_as_the_result() {
        let mut st = CodexState::default();
        let evs = feed(&FIXTURE, &mut st);
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "tool", "log", "result"]);
        assert_eq!(evs[2].text, r#"scarlet.transcript_get {"mediaId":"m1"}"#);
        assert_eq!(evs[3].text, "shell bash -lc ls");
        assert_eq!(evs[5].text, "Proposed the first cut as chg_2.");
        assert!(st.turn_completed);
        assert_eq!(st.last_message.as_deref(), Some("Proposed the first cut as chg_2."));
    }

    #[test]
    fn handles_questions_failed_turns_and_bare_errors() {
        let mut st = CodexState::default();
        let evs = feed(
            &[
                r#"{"type":"item.started","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}}"#,
            ],
            &mut st,
        );
        assert_eq!(evs, vec![RunnerEvent::with("question", "Which take?", json!({"tool":"scarlet.task_question","itemId":"q"}))]);
        assert_eq!(st.question.as_deref(), Some("Which take?"));
        assert!(st.question_posted);
        assert!(st.should_stop);

        let mut st2 = CodexState::default();
        let e2 = feed(&[r#"{"type":"turn.failed","error":{"message":"rate limited"}}"#, r#"{"type":"error","message":"boom"}"#], &mut st2);
        assert_eq!(e2.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect::<Vec<_>>(), [("error", "rate limited"), ("error", "boom")]);
        assert_eq!(st2.failed.as_deref(), Some("boom"));
    }

    #[test]
    fn carries_on_after_codex_recovers_from_a_dropped_stream() {
        let drop = "stream disconnected before completion: websocket closed by server before response.completed";
        let mut st = CodexState::default();
        let evs = feed(
            &[
                &format!(r#"{{"type":"error","message":"Reconnecting... 2/5 ({drop})"}}"#),
                &format!(r#"{{"type":"item.completed","item":{{"id":"w","type":"error","message":"Falling back from WebSockets to HTTPS transport. {drop}"}}}}"#),
                r#"{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Saved all 119 recommendations."}}"#,
                r#"{"type":"turn.completed","usage":{}}"#,
            ],
            &mut st,
        );
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["log", "log", "log", "result"]);
        assert!(st.failed.is_none());
        assert!(st.retry_notice.as_deref().unwrap().starts_with("Reconnecting... 2/5"));
        assert!(st.turn_completed);
        // A retry that never recovers still fails the turn.
        let mut gave_up = CodexState::default();
        feed(&[&format!(r#"{{"type":"error","message":"Reconnecting... 5/5 ({drop})"}}"#), &format!(r#"{{"type":"turn.failed","error":{{"message":"{drop}"}}}}"#)], &mut gave_up);
        assert_eq!(gave_up.failed.as_deref(), Some(drop));
        assert!(!is_retry_notice("Reconnecting... soon"));
    }

    #[test]
    fn passes_on_the_plan_codex_keeps_once_for_each_change() {
        // Recorded from codex-cli 0.166.0-alpha.5.1 run with tools.update_plan.enabled=true: the whole list each time, and
        // the last one again as the turn ends. A step is finished or not; nothing says which is under way.
        let list = |kind: &str, first: bool| json!({"type": kind, "item": {"id": "item_1", "type": "todo_list", "items": [
            {"text": "Step 1", "completed": first}, {"text": "Step 2", "completed": false}, {"text": "Step 3", "completed": false}]}}).to_string();
        let mut st = CodexState::default();
        let evs = feed(
            &[
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll make the two plan updates now."}}"#,
                &list("item.started", false),
                &list("item.updated", true),
                r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}"#,
                &list("item.completed", true),
            ],
            &mut st,
        );
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["log", "plan", "plan", "log"]);
        assert_eq!(evs[1], RunnerEvent::with("plan", "[ ] Step 1\n[ ] Step 2\n[ ] Step 3", json!({"steps": [
            {"text": "Step 1", "state": "pending"}, {"text": "Step 2", "state": "pending"}, {"text": "Step 3", "state": "pending"}]})));
        assert_eq!(evs[2].text, "[x] Step 1\n[ ] Step 2\n[ ] Step 3");
        // A list Scarlet can't read is passed over.
        assert!(feed(&[r#"{"type":"item.updated","item":{"id":"item_1","type":"todo_list"}}"#], &mut st).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn grants_only_the_resolved_codex_executable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("codex \"native\"");
        let link = dir.path().join("codex");
        std::fs::write(&target, "fixture").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let resolved = std::fs::canonicalize(&target).unwrap().to_string_lossy().into_owned();
        let cmd = build_codex_command(None, None, None, "SYS", "x", false, &mcp(), Path::new("/w"), link.to_str().unwrap(), Path::new("/w/.scarlet")).cmd;
        assert_eq!(cmd.file, resolved);
        assert!(cmd.args.contains(&format!("permissions.scarlet.filesystem={{\":root\"=\"deny\",\":minimal\"=\"read\",\":workspace_roots\"={{\".\"=\"write\"}},{path}=\"read\"}}", path = toml_string(&resolved))));
        assert!(cmd.args.contains(&"permissions.scarlet.network.enabled=false".to_string()));
        assert!(!cmd.args.iter().any(|arg| arg.contains("danger-full-access")));
        let (opts, _) = crate::host::runner::testing::options("codex", dir.path(), None);
        let args = app_server_args(&opts, Some(&resolved));
        assert!(args.contains(&format!("permissions.scarlet.filesystem={{\":root\"=\"deny\",\":minimal\"=\"read\",\":workspace_roots\"={{\".\"=\"write\"}},{path}=\"read\"}}", path = toml_string(&resolved))));
        assert!(args.contains(&"project_doc_max_bytes=4194304".to_string()));
    }

    #[test]
    fn builds_c_overrides_as_valid_toml() {
        assert_eq!(toml_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        let mcp = mcp();
        let built = build_codex_command(Some("gpt-5-codex"), None, None, "SYS", "Cut it", false, &mcp, Path::new("C:\\work\\t1"), "codex.cmd", Path::new("C:\\work\\t1\\.scarlet"));
        let cmd = built.cmd;
        assert_eq!(&cmd.args[..5], &["exec", "--json", "--skip-git-repo-check", "--cd", "C:\\work\\t1"]);
        assert!(cmd.args.windows(2).any(|p| p == ["--disable", "shell_tool"]));
        assert!(cmd.args.contains(&r#"default_permissions="scarlet""#.to_string()));
        assert_eq!(cmd.args.contains(&r#"windows.sandbox="mxc""#.to_string()), cfg!(windows));
        assert!(cmd.args.contains(&r#"mcp_servers.scarlet.default_tools_approval_mode="approve""#.to_string()));
        assert!(cmd.args.contains(&"mcp_servers.scarlet.command=\"C:/Program Files/nodejs/node.exe\"".to_string()));
        assert!(cmd.args.contains(&"mcp_servers.scarlet.args=[\"C:/scarlet/packages/mcp/dist/cli.js\"]".to_string()));
        assert!(cmd.args.contains(&"mcp_servers.scarlet.env_vars=[\"SCARLET_SERVER\",\"SCARLET_TOKEN\"]".to_string()));
        assert!(cmd.args.contains(&"mcp_servers.scarlet.required=true".to_string()));
        assert!(cmd.args.windows(2).any(|p| p == ["-c", "project_doc_max_bytes=4194304"]));
        assert_eq!(&cmd.args[cmd.args.len() - 3..], &["--model", "gpt-5-codex", "-"]);
        let tuned = build_codex_command(None, Some("ultra"), Some("priority"), "SYS", "x", false, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
        assert_eq!(&tuned.args[tuned.args.len() - 5..], &["-c", "model_reasoning_effort=\"ultra\"", "-c", "service_tier=\"priority\"", "-"]);
        assert!(cmd.files.keys().next().unwrap().ends_with("AGENTS.md"));
        let long = build_codex_command(None, None, None, "SYS", "a\nb", false, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
        assert_eq!(long.args.last().unwrap(), "-");
        assert_eq!(long.stdin.as_deref(), Some("a\nb"));
        // Codex's to-do tool is switched on only when the engine asks for the agent's plan.
        assert!(!long.args.iter().any(|a| a == "tools.update_plan.enabled=true"));
        let planned = build_codex_command(None, None, None, "SYS", "a\nb", true, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
        assert_eq!(planned.args.iter().filter(|a| !long.args.contains(a)).collect::<Vec<_>>(), ["tools.update_plan.enabled=true"]);
        // Ephemeral: Scarlet runs stay out of the user's Codex thread list.
        assert!(cmd.args.iter().any(|a| a == "--ephemeral"));
        assert!(!cmd.args.iter().any(|a| a == "resume"));
    }

    #[test]
    fn sums_usage_across_turns_and_separates_cached_input() {
        let mut st = CodexState::default();
        feed(&[
            r#"{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50,"reasoning_output_tokens":20}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
        ], &mut st);
        let u = st.usage.unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.reasoning_tokens), (210, 55, 800, 20));
    }

    #[cfg(unix)]
    mod runs {
        use super::super::*;
        use crate::host::runner::testing::{fake_cli, options as runner_options};

        fn options(agent: &str, cwd: &Path, bin: Option<String>) -> (RunOptions, Arc<Mutex<Vec<RunnerEvent>>>) {
            let (mut opts, events) = runner_options(agent, cwd, bin);
            // Fixtures choose their credential store independently of the developer running the tests.
            opts.env.retain(|key, _| !key.eq_ignore_ascii_case("CODEX_HOME") && !api_key_vars("codex").iter().any(|name| key.eq_ignore_ascii_case(name)));
            opts.env.insert("CODEX_HOME".into(), cwd.join("empty-codex-home").to_string_lossy().into_owned());
            (opts, events)
        }

        const STARTED: &str = r#"{"type":"thread.started","thread_id":"t_1"}"#;
        const MESSAGE: &str = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Proposed the first cut."}}"#;
        const DONE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#;

        #[tokio::test]
        async fn app_server_reports_cumulative_usage_before_the_edit_finishes() {
            use std::os::unix::fs::PermissionsExt;

            let dir = tempfile::tempdir().unwrap();
            let auth_home = tempfile::tempdir().unwrap();
            let auth = auth_home.path().join("auth.json");
            std::fs::write(&auth, "{}").unwrap();
            let bin = dir.path().join("fake-app-server");
            std::fs::write(&bin, r#"#!/bin/sh
set -eu
test "$1" = app-server
test -L "$CODEX_HOME/auth.json"
test -L "$CODEX_HOME/auth.lock"
test -z "${CODEX_SQLITE_HOME:-}"
read -r request
printf '%s\n' '{"id":1,"result":{}}'
read -r request
read -r request
printf '%s\n' '{"id":2,"result":{"thread":{"id":"t1","ephemeral":true},"model":"resolved-model","approvalPolicy":"never","activePermissionProfile":{"id":"scarlet"}}}'
read -r request
case "$request" in *'"text":"Cut the pauses"'*'"text_elements":[]'*) ;; *) exit 4 ;; esac
cat <<'EVENTS'
{"id":3,"result":{"turn":{"id":"turn1"}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":40,"cacheWriteInputTokens":30,"outputTokens":10,"reasoningOutputTokens":5}}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":40,"cacheWriteInputTokens":30,"outputTokens":10,"reasoningOutputTokens":5}}}}
{"method":"item/completed","params":{"threadId":"t1","turnId":"turn1","item":{"type":"agentMessage","phase":"final_answer","text":"Cut the pauses."}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":210,"cachedInputTokens":50,"cacheWriteInputTokens":40,"outputTokens":20,"reasoningOutputTokens":8}}}}
{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"completed"}}}
EVENTS
cat >/dev/null
"#).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let (mut opts, _) = options("codex", dir.path(), Some(bin.to_string_lossy().into_owned()));
            opts.env.insert("CODEX_HOME".into(), auth_home.path().to_string_lossy().into_owned());
            opts.env.insert("CODEX_SQLITE_HOME".into(), auth_home.path().to_string_lossy().into_owned());
            opts.timeout = Some(std::time::Duration::from_secs(10));
            let reports = Arc::new(Mutex::new(Vec::new()));
            let live = reports.clone();
            opts.on_usage = Some(Arc::new(move |usage| live.lock().unwrap().push(usage)));
            let live = reports.clone();
            opts.on_event = Arc::new(move |event| {
                if event.text == "Cut the pauses." && event.kind == "log" {
                    assert_eq!(live.lock().unwrap().len(), 1, "the first count must arrive during the turn");
                }
            });
            let result = run_codex(opts).await;
            assert!(result.ok, "{result:?}");
            assert_eq!(result.summary, "Cut the pauses.");
            let reports = reports.lock().unwrap();
            assert_eq!(reports.len(), 2);
            assert_eq!((reports[0].input_tokens, reports[0].cache_read_tokens, reports[0].cache_write_tokens), (30, 40, 30));
            assert_eq!((reports[1].input_tokens, reports[1].output_tokens, reports[1].reasoning_tokens), (120, 20, 8));
            assert_eq!(reports[1].model.as_deref(), Some("resolved-model"));
            assert_eq!(result.usage.as_ref(), reports.last());
            assert_eq!(std::fs::read_to_string(auth).unwrap(), "{}");
        }

        #[tokio::test]
        async fn reports_a_finished_run_and_prefers_the_last_message_file() {
            let dir = tempfile::tempdir().unwrap();
            let (opts, events) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], "exit 0")));
            let run = run_codex(opts).await;
            assert!(run.ok, "{run:?}");
            assert_eq!((run.summary.as_str(), run.error.as_deref(), run.exit_code), ("Proposed the first cut.", None, Some(0)));
            assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((10, 5)));
            assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "result"]);
            // Codex reads its instructions from the task folder.
            assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "SYSTEM");

            // What Codex wrote to --output-last-message is the summary, over the last message in the stream. It also
            // gets the engine's address and token in its environment, where its MCP server reads them.
            let writes = r#"while [ $# -gt 1 ]; do if [ "$1" = "--output-last-message" ]; then printf 'Server %s, token %s.\n' "$SCARLET_SERVER" "$SCARLET_TOKEN" > "$2"; fi; shift; done"#;
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], writes)));
            assert_eq!(run_codex(opts).await.summary, "Server http://127.0.0.1:4000, token sct_test.");
        }

        #[tokio::test]
        async fn gives_the_reason_a_run_failed() {
            let dir = tempfile::tempdir().unwrap();
            // A failed turn is the reason, even with a clean exit.
            let failed = r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#;
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, failed], "exit 0")));
            let run = run_codex(opts).await;
            assert_eq!((run.ok, run.error.as_deref()), (false, Some("model overloaded")));
            // Died with nothing but a reconnect notice: the notice explains it.
            let retry = r#"{"type":"error","message":"Reconnecting... 5/5"}"#;
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, retry], "exit 1")));
            assert_eq!(run_codex(opts).await.error.as_deref(), Some("Reconnecting... 5/5"));
            // Died with nothing at all: the exit code and stderr.
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED], "echo 'not signed in' >&2; exit 2")));
            let run = run_codex(opts).await;
            assert_eq!((run.error.as_deref(), run.exit_code), (Some("codex exited with code 2: not signed in"), Some(2)));
            // A turn that completed counts, whatever the exit code.
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], "exit 1")));
            assert!(run_codex(opts).await.ok);
        }

        #[tokio::test]
        async fn pauses_on_a_question_and_reports_a_stall_or_a_cancel() {
            let dir = tempfile::tempdir().unwrap();
            let ask = r#"{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}}"#;
            let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, ask], "sleep 30")));
            let run = run_codex(opts).await;
            assert!(run.ok && run.question_posted, "{run:?}");
            assert_eq!(run.question.as_deref(), Some("Which take?"));

            let (mut opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE], "sleep 30")));
            // Long enough for the stand-in to start and speak on a busy machine.
            opts.stall = Some(std::time::Duration::from_secs(8));
            let run = run_codex(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.timed_out, run.stalled), (false, Some("stalled"), true, true));
            assert_eq!(run.summary, "Proposed the first cut.");

            let (mut opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE], "sleep 30")));
            let cancel = opts.cancel.clone();
            opts.on_event = Arc::new(move |_| cancel.cancel());
            let run = run_codex(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.aborted), (false, Some("cancelled"), true));
        }
    }
}
