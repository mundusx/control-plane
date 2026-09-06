use crate::contracts::{
    CapabilityRequirement, CapacityClass, JobPlan, JobRequest, JobSchedulingRequirements, NodeRole,
    PlannedJob, RequestClassification, RequestTaskType, StepWorkloadRequirements,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const PLANNER_URL_ENV: &str = "MUNDUSX_PLANNER_URL";
const PLANNER_TIMEOUT_MS_ENV: &str = "MUNDUSX_PLANNER_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS: u64 = 1500;

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannerUrl {
    scheme: UrlScheme,
    host: String,
    port: u16,
    path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum UrlScheme {
    Http,
    Https,
}

#[derive(Clone, Debug)]
struct PlannerProbeConfig {
    url: String,
    timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct PlannerPlanResult {
    pub plan: JobPlan,
    pub requirements: JobSchedulingRequirements,
    pub provider: String,
    pub status: String,
    pub degraded_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct PlannerResponseWire {
    planner_provider: Option<String>,
    planner_status: Option<String>,
    degraded_reason: Option<String>,
    plan: Option<PlanWire>,
    graph: Option<GraphWire>,
    scheduling_requirements: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
struct PlanWire {
    summary: Option<String>,
    steps: Option<Vec<PlanStepWire>>,
}

#[derive(Clone, Debug, Deserialize)]
struct GraphWire {
    nodes: Option<Vec<PlanStepWire>>,
}

#[derive(Clone, Debug, Deserialize)]
struct PlanStepWire {
    id: String,
    name: Option<String>,
    responsibility: Option<String>,
    depends_on: Option<Vec<String>>,
    required_output: Option<String>,
    reason: Option<String>,
    recommended_max_tokens: Option<u32>,
    minimum_max_tokens: Option<u32>,
    #[serde(default)]
    minimum_capacity_class: CapacityClass,
    #[serde(default)]
    recommended_capacity_class: CapacityClass,
    #[serde(default)]
    context_budget_tokens: u32,
    #[serde(default)]
    expected_artifact_count: u32,
    #[serde(default)]
    expected_artifact_bytes: u64,
    #[serde(default)]
    model_quality_floor: String,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    requires_repository: bool,
    #[serde(default)]
    requires_compile: bool,
    #[serde(default)]
    requires_tests: bool,
    #[serde(default)]
    validation_level: String,
    #[serde(default = "default_allowed_parallelism")]
    allowed_parallelism: u32,
    #[serde(default)]
    reducer_credibility: String,
    #[serde(default)]
    synthesizer_credibility: String,
    #[serde(default)]
    capability_requirements: Vec<CapabilityRequirement>,
}
fn default_allowed_parallelism() -> u32 {
    1
}

#[derive(Clone, Debug, Serialize)]
pub struct PlannerServiceStatus {
    pub enabled: bool,
    pub url_configured: bool,
    pub url: Option<String>,
    pub reachable: bool,
    pub provider: String,
    pub status: String,
    pub fallback_mode: bool,
    pub latency_ms: Option<u128>,
    pub last_error: Option<String>,
}

impl PlannerProbeConfig {
    fn from_env() -> Option<Self> {
        let url = std::env::var(PLANNER_URL_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let timeout_ms = std::env::var(PLANNER_TIMEOUT_MS_ENV)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        Some(Self {
            url,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
}

pub fn plan_from_env(
    request: &JobRequest,
    classification: &RequestClassification,
    base_requirements: &JobSchedulingRequirements,
    capability_summary: &Value,
) -> Result<Option<PlannerPlanResult>, String> {
    let Some(config) = PlannerProbeConfig::from_env() else {
        return Ok(None);
    };
    let response = request_plan(&config, request, classification, capability_summary)?;
    let result = response_to_plan(response, request, base_requirements);
    validate_external_plan(&result.plan)?;
    Ok(Some(result))
}

pub fn planner_service_status_from_env() -> PlannerServiceStatus {
    let Some(config) = PlannerProbeConfig::from_env() else {
        return PlannerServiceStatus {
            enabled: false,
            url_configured: false,
            url: None,
            reachable: false,
            provider: "rust".to_string(),
            status: "disabled".to_string(),
            fallback_mode: true,
            latency_ms: None,
            last_error: None,
        };
    };

    let request = JobRequest {
        request_id: "planner-status-probe".to_string(),
        prompt: "Answer health probe.".to_string(),
        preferred_backend: crate::contracts::Backend::Auto,
        routing_mode: crate::contracts::RoutingMode::Normal,
        runtime_mode: crate::contracts::RuntimeMode::Local,
        execution_mode: crate::contracts::JobExecutionMode::Single,
        stream: false,
        model: None,
        system_prompt: None,
        max_tokens: Some(1),
        max_tokens_source: Some("planner_status_probe".to_string()),
        temperature: None,
        top_p: None,
        seed: None,
    };
    let classification = RequestClassification::default();
    let started = Instant::now();
    match request_plan(&config, &request, &classification, &json!({})) {
        Ok(response) => PlannerServiceStatus {
            enabled: true,
            url_configured: true,
            url: Some(config.url),
            reachable: true,
            provider: response
                .planner_provider
                .unwrap_or_else(|| "planner-service".to_string()),
            status: response
                .planner_status
                .unwrap_or_else(|| "planned".to_string()),
            fallback_mode: false,
            latency_ms: Some(started.elapsed().as_millis()),
            last_error: response.degraded_reason,
        },
        Err(error) => PlannerServiceStatus {
            enabled: true,
            url_configured: true,
            url: Some(config.url),
            reachable: false,
            provider: "rust".to_string(),
            status: "degraded".to_string(),
            fallback_mode: true,
            latency_ms: Some(started.elapsed().as_millis()),
            last_error: Some(error),
        },
    }
}

fn request_plan(
    config: &PlannerProbeConfig,
    request: &JobRequest,
    classification: &RequestClassification,
    capability_summary: &Value,
) -> Result<PlannerResponseWire, String> {
    let parsed = parse_planner_url(&config.url)?;
    let body = json!({
        "request_id": request.request_id,
        "prompt": request.prompt,
        "model": request.model,
        "classification": classification,
        "available_capability_summary": capability_summary,
        "policy": {
            "preferred_backend": request.preferred_backend,
            "runtime_mode": request.runtime_mode,
            "execution_mode": request.execution_mode,
            "stream": request.stream
        }
    })
    .to_string();
    let stream = connect_with_timeout(parsed.host.as_str(), parsed.port, config.timeout)?;
    stream
        .set_read_timeout(Some(config.timeout))
        .map_err(|error| format!("planner_read_timeout_setup_failed: {error}"))?;
    stream
        .set_write_timeout(Some(config.timeout))
        .map_err(|error| format!("planner_write_timeout_setup_failed: {error}"))?;
    let request_text = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        parsed.path,
        parsed.host,
        body.len(),
        body
    );
    let response = match parsed.scheme {
        UrlScheme::Http => exchange_http(stream, request_text.as_bytes()),
        UrlScheme::Https => {
            let connector = native_tls::TlsConnector::new()
                .map_err(|error| format!("planner_tls_setup_failed: {error}"))?;
            let tls_stream = connector
                .connect(parsed.host.as_str(), stream)
                .map_err(|error| format!("planner_tls_connect_failed: {error}"))?;
            exchange_http(tls_stream, request_text.as_bytes())
        }
    }?;
    serde_json::from_str(&response)
        .map_err(|error| format!("planner_response_decode_failed: {error}"))
}

fn validate_external_plan(plan: &JobPlan) -> Result<(), String> {
    use std::collections::{BTreeMap, BTreeSet};

    if plan.jobs.is_empty() {
        return Err("planner_invalid_graph:empty".to_string());
    }
    if plan.jobs.len() > 24 {
        return Err("planner_invalid_graph:too_many_steps".to_string());
    }

    let ids = plan
        .jobs
        .iter()
        .map(|job| job.id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != plan.jobs.len() {
        return Err("planner_invalid_graph:duplicate_step_id".to_string());
    }
    if plan.jobs.iter().any(|job| {
        job.depends_on
            .iter()
            .any(|dependency| dependency == &job.id || !ids.contains(dependency.as_str()))
    }) {
        return Err("planner_invalid_graph:unknown_or_self_dependency".to_string());
    }

    let mut indegree = plan
        .jobs
        .iter()
        .map(|job| (job.id.as_str(), job.depends_on.len()))
        .collect::<BTreeMap<_, _>>();
    let mut ready = indegree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect::<Vec<_>>();
    let mut visited = 0;
    while let Some(completed) = ready.pop() {
        visited += 1;
        for job in &plan.jobs {
            if job
                .depends_on
                .iter()
                .any(|dependency| dependency == completed)
            {
                let degree = indegree.get_mut(job.id.as_str()).expect("known step");
                *degree -= 1;
                if *degree == 0 {
                    ready.push(job.id.as_str());
                }
            }
        }
    }
    if visited != plan.jobs.len() {
        return Err("planner_invalid_graph:cycle".to_string());
    }
    Ok(())
}

fn exchange_http<S: Read + Write>(mut stream: S, request: &[u8]) -> Result<String, String> {
    stream
        .write_all(request)
        .map_err(|error| format!("planner_write_failed: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("planner_read_failed: {error}"))?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "planner_invalid_http_response".to_string())?;
    let status = head.lines().next().unwrap_or("unknown status");
    if !status.contains(" 200 ") {
        return Err(format!("planner_http_error: {status}"));
    }
    Ok(body.to_string())
}

fn response_to_plan(
    response: PlannerResponseWire,
    request: &JobRequest,
    base_requirements: &JobSchedulingRequirements,
) -> PlannerPlanResult {
    let provider = response
        .planner_provider
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "planner-service".to_string());
    let status = response
        .planner_status
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "planned".to_string());
    let steps = response
        .plan
        .as_ref()
        .and_then(|plan| plan.steps.clone())
        .or_else(|| {
            response
                .graph
                .as_ref()
                .and_then(|graph| graph.nodes.clone())
        })
        .unwrap_or_default();
    let jobs = steps
        .into_iter()
        .filter_map(|step| {
            let id = step.id.trim();
            if id.is_empty() {
                return None;
            }
            Some(PlannedJob {
                id: id.to_string(),
                name: step.name.unwrap_or_else(|| id.to_string()),
                responsibility: step
                    .responsibility
                    .unwrap_or_else(|| "execution".to_string()),
                depends_on: step.depends_on.unwrap_or_default(),
                required_output: step.required_output.unwrap_or_else(|| {
                    "Return the completed work for this planner step.".to_string()
                }),
                reason: step
                    .reason
                    .unwrap_or_else(|| "Planner service selected this step.".to_string()),
                recommended_max_tokens: step.recommended_max_tokens,
                minimum_max_tokens: step.minimum_max_tokens,
                workload: StepWorkloadRequirements {
                    minimum_capacity_class: step.minimum_capacity_class,
                    recommended_capacity_class: step.recommended_capacity_class,
                    context_budget_tokens: step.context_budget_tokens,
                    expected_artifact_count: step.expected_artifact_count,
                    expected_artifact_bytes: step.expected_artifact_bytes,
                    model_quality_floor: step.model_quality_floor,
                    required_tools: step.required_tools,
                    requires_repository: step.requires_repository,
                    requires_compile: step.requires_compile,
                    requires_tests: step.requires_tests,
                    validation_level: step.validation_level,
                    allowed_parallelism: step.allowed_parallelism,
                    reducer_credibility: step.reducer_credibility,
                    synthesizer_credibility: step.synthesizer_credibility,
                    capability_requirements: step.capability_requirements,
                },
            })
        })
        .collect::<Vec<_>>();
    let plan = JobPlan {
        plan_id: format!("plan-{}", request.request_id),
        strategy: provider.clone(),
        summary: response
            .plan
            .and_then(|plan| plan.summary)
            .unwrap_or_else(|| format!("{provider} returned {} execution units.", jobs.len())),
        jobs,
    };
    PlannerPlanResult {
        plan,
        requirements: merge_requirements(base_requirements, response.scheduling_requirements),
        provider,
        status,
        degraded_reason: response.degraded_reason,
    }
}

fn merge_requirements(
    base: &JobSchedulingRequirements,
    value: Option<Value>,
) -> JobSchedulingRequirements {
    let Some(value) = value else {
        return base.clone();
    };
    let mut requirements = base.clone();
    if let Some(task_type) = value.get("task_type").and_then(Value::as_str) {
        requirements.task_type = match task_type {
            "chat" => RequestTaskType::Chat,
            "coding" => RequestTaskType::Coding,
            "document" => RequestTaskType::Document,
            _ => RequestTaskType::Inference,
        };
    }
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        requirements.model = Some(model.to_string());
    }
    if let Some(roles) = value.get("preferred_roles").and_then(Value::as_array) {
        requirements.preferred_roles = roles
            .iter()
            .filter_map(Value::as_str)
            .filter_map(parse_node_role)
            .collect();
    }
    if let Some(capabilities) = value.get("capability_requirements") {
        if let Ok(parsed) =
            serde_json::from_value::<Vec<CapabilityRequirement>>(capabilities.clone())
        {
            requirements.capability_requirements = parsed;
        }
    }
    requirements
}

fn parse_node_role(value: &str) -> Option<NodeRole> {
    match value {
        "chat" => Some(NodeRole::Chat),
        "coding" => Some(NodeRole::Coding),
        "vision" => Some(NodeRole::Vision),
        "embedding" => Some(NodeRole::Embedding),
        "tool_use" => Some(NodeRole::ToolUse),
        "chunk_analysis" => Some(NodeRole::ChunkAnalysis),
        "reducer" => Some(NodeRole::Reducer),
        "synthesizer" => Some(NodeRole::Synthesizer),
        "batch" => Some(NodeRole::Batch),
        _ => None,
    }
}

fn connect_with_timeout(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("planner_resolve_failed: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("planner_resolve_failed: no_addresses".to_string());
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    Err(format!(
        "planner_connect_failed: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no_addresses".to_string())
    ))
}

fn parse_planner_url(url: &str) -> Result<PlannerUrl, String> {
    let (scheme, rest, default_port) = if let Some(rest) = url.strip_prefix("http://") {
        (UrlScheme::Http, rest, 80)
    } else if let Some(rest) = url.strip_prefix("https://") {
        (UrlScheme::Https, rest, 443)
    } else {
        return Err("planner_url_must_use_http_or_https".to_string());
    };
    let (authority, path) = rest
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        let parsed_port = port
            .parse::<u16>()
            .map_err(|_| "planner_url_invalid_port".to_string())?;
        (host.to_string(), parsed_port)
    } else {
        (authority.to_string(), default_port)
    };
    if host.trim().is_empty() {
        return Err("planner_url_missing_host".to_string());
    }
    Ok(PlannerUrl {
        scheme,
        host,
        port,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn planned_job(id: &str, depends_on: Vec<&str>) -> PlannedJob {
        PlannedJob {
            id: id.to_string(),
            name: id.to_string(),
            responsibility: "test".to_string(),
            depends_on: depends_on.into_iter().map(str::to_string).collect(),
            required_output: "test output".to_string(),
            reason: "test plan".to_string(),
            recommended_max_tokens: None,
            minimum_max_tokens: None,
            workload: StepWorkloadRequirements::default(),
        }
    }

    #[test]
    fn planner_status_reports_disabled_without_url() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var(PLANNER_URL_ENV);
        std::env::remove_var(PLANNER_TIMEOUT_MS_ENV);

        let status = planner_service_status_from_env();

        assert!(!status.enabled);
        assert!(!status.url_configured);
        assert_eq!(status.status, "disabled");
        assert_eq!(status.provider, "rust");
        assert!(status.fallback_mode);
    }

    #[test]
    fn planner_status_reports_degraded_when_configured_service_is_down() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var(PLANNER_URL_ENV, "http://127.0.0.1:1/v1/plan");
        std::env::set_var(PLANNER_TIMEOUT_MS_ENV, "5");

        let status = planner_service_status_from_env();

        std::env::remove_var(PLANNER_URL_ENV);
        std::env::remove_var(PLANNER_TIMEOUT_MS_ENV);

        assert!(status.enabled);
        assert!(status.url_configured);
        assert!(!status.reachable);
        assert_eq!(status.status, "degraded");
        assert_eq!(status.provider, "rust");
        assert!(status.fallback_mode);
        assert!(status.last_error.is_some());
    }

    #[test]
    fn planner_status_reports_degraded_when_host_cannot_resolve() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var(
            PLANNER_URL_ENV,
            "https://planner.invalid.invalid:8091/v1/plan",
        );
        std::env::set_var(PLANNER_TIMEOUT_MS_ENV, "5");

        let status = planner_service_status_from_env();

        std::env::remove_var(PLANNER_URL_ENV);
        std::env::remove_var(PLANNER_TIMEOUT_MS_ENV);

        assert!(status.enabled);
        assert!(!status.reachable);
        assert_eq!(status.status, "degraded");
        assert!(status.fallback_mode);
        assert!(status
            .last_error
            .as_deref()
            .unwrap_or_default()
            .starts_with("planner_resolve_failed"));
    }

    #[test]
    fn parses_http_url_with_default_path() {
        let parsed = parse_planner_url("http://127.0.0.1:8091").expect("parse url");

        assert_eq!(
            parsed,
            PlannerUrl {
                scheme: UrlScheme::Http,
                host: "127.0.0.1".to_string(),
                port: 8091,
                path: "/".to_string(),
            }
        );
    }

    #[test]
    fn parses_https_url_with_default_port() {
        let parsed =
            parse_planner_url("https://planner.railway.internal/v1/plan").expect("parse url");

        assert_eq!(
            parsed,
            PlannerUrl {
                scheme: UrlScheme::Https,
                host: "planner.railway.internal".to_string(),
                port: 443,
                path: "/v1/plan".to_string(),
            }
        );
    }

    #[test]
    fn accepts_valid_external_dag() {
        let plan = JobPlan {
            plan_id: "plan-test".to_string(),
            strategy: "planner".to_string(),
            summary: "test".to_string(),
            jobs: vec![
                planned_job("scope", vec![]),
                planned_job("implementation", vec!["scope"]),
                planned_job("documentation", vec!["scope"]),
                planned_job("synthesize", vec!["implementation", "documentation"]),
            ],
        };

        assert!(validate_external_plan(&plan).is_ok());
    }

    #[test]
    fn planner_can_refine_weighted_capability_requirements() {
        let base = JobSchedulingRequirements::default();
        let requirements = merge_requirements(
            &base,
            Some(json!({
                "capability_requirements": [
                    {
                        "capability": "coding",
                        "weight": 95,
                        "minimum_score": 70,
                        "required": true
                    },
                    {
                        "capability": "logic",
                        "weight": 75,
                        "minimum_score": 50,
                        "required": false
                    }
                ]
            })),
        );

        assert_eq!(requirements.capability_requirements.len(), 2);
        assert_eq!(requirements.capability_requirements[0].capability, "coding");
        assert!(requirements.capability_requirements[0].required);
        assert_eq!(requirements.capability_requirements[1].weight, 75);
    }

    #[test]
    fn rejects_external_dag_cycles_and_unknown_dependencies() {
        let cyclic = JobPlan {
            plan_id: "plan-cycle".to_string(),
            strategy: "planner".to_string(),
            summary: "cycle".to_string(),
            jobs: vec![planned_job("a", vec!["b"]), planned_job("b", vec!["a"])],
        };
        assert_eq!(
            validate_external_plan(&cyclic),
            Err("planner_invalid_graph:cycle".to_string())
        );

        let unknown = JobPlan {
            plan_id: "plan-unknown".to_string(),
            strategy: "planner".to_string(),
            summary: "unknown".to_string(),
            jobs: vec![planned_job("a", vec!["missing"])],
        };
        assert_eq!(
            validate_external_plan(&unknown),
            Err("planner_invalid_graph:unknown_or_self_dependency".to_string())
        );
    }
}
