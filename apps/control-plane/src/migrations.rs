use native_tls::TlsConnector;
use postgres::{Client, Config};
use postgres_native_tls::MakeTlsConnector;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct MigrationFile {
    pub version: String,
    pub name: String,
    pub sql: String,
    pub path: PathBuf,
}

pub fn migration_files() -> Result<Vec<MigrationFile>, String> {
    let root = repo_root()?;
    migration_files_in_root(&root)
}

fn migration_files_in_root(root: &Path) -> Result<Vec<MigrationFile>, String> {
    let source = migration_source(root);
    let mut files = Vec::new();

    let schema_path = source.schema_path;
    if schema_path.exists() {
        files.push(read_migration_file(&schema_path, "0000", "schema")?);
    }

    let migrations_dir = source.migrations_dir;
    if migrations_dir.exists() {
        let mut entries = fs::read_dir(&migrations_dir)
            .map_err(|error| format!("failed to read migrations dir: {error}"))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("sql"))
            .collect::<Vec<_>>();
        entries.sort();

        for path in entries {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("invalid migration filename: {}", path.display()))?;
            let version = file_name
                .split_once('_')
                .map(|(version, _)| version.to_string())
                .unwrap_or_else(|| file_name.trim_end_matches(".sql").to_string());
            let name = file_name
                .trim_end_matches(".sql")
                .split_once('_')
                .map(|(_, name)| name.to_string())
                .unwrap_or_else(|| "migration".to_string());
            files.push(read_migration_file(&path, &version, &name)?);
        }
    }

    files.sort_by(|a, b| a.version.cmp(&b.version).then_with(|| a.name.cmp(&b.name)));
    Ok(files)
}

#[derive(Clone, Debug)]
struct MigrationSource {
    schema_path: PathBuf,
    migrations_dir: PathBuf,
}

fn migration_source(root: &Path) -> MigrationSource {
    let postgres_schema_path = root.join("db/schema.sql");
    let postgres_migrations_dir = root.join("db/migrations");
    if postgres_schema_path.exists() || postgres_migrations_dir.exists() {
        return MigrationSource {
            schema_path: postgres_schema_path,
            migrations_dir: postgres_migrations_dir,
        };
    }

    MigrationSource {
        schema_path: root.join("supabase/schema.sql"),
        migrations_dir: root.join("supabase/migrations"),
    }
}

pub fn apply_migrations(database_url: &str) -> Result<Vec<MigrationFile>, String> {
    let mut client = connect_client(database_url)?;

    client
        .batch_execute(
            r#"
            create table if not exists public.schema_migrations (
                version text primary key,
                name text not null,
                checksum text not null,
                applied_at timestamptz not null default now()
            );
        "#,
        )
        .map_err(|error| format!("failed to create schema_migrations: {error}"))?;

    let applied = applied_versions(&mut client)?;
    let migrations = migration_files()?;
    let mut applied_files = Vec::new();

    for migration in migrations {
        if applied.contains(&migration.version) {
            continue;
        }

        client.batch_execute(&migration.sql).map_err(|error| {
            format!(
                "failed to apply migration {}: {}",
                migration.version,
                db_error_message(&error)
            )
        })?;

        let checksum = checksum(&migration.sql);
        client
            .execute(
                "insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3) on conflict (version) do update set name = excluded.name, checksum = excluded.checksum, applied_at = now()",
                &[&migration.version, &migration.name, &checksum],
            )
            .map_err(|error| {
                format!(
                    "failed to record migration {}: {}",
                    migration.version,
                    db_error_message(&error)
                )
            })?;

        applied_files.push(migration);
    }

    Ok(applied_files)
}

fn connect_client(database_url: &str) -> Result<Client, String> {
    let mut config = Config::from_str(database_url)
        .map_err(|error| format!("failed to parse database url: {error}"))?;
    config.connect_timeout(Duration::from_secs(10));

    let strict_connector =
        postgres_connector(false).map_err(|error| format!("failed to build TLS: {error}"))?;
    match config.connect(strict_connector) {
        Ok(client) => Ok(client),
        Err(strict_error) => {
            eprintln!(
                "strict database TLS failed, retrying with relaxed certificate checks: {strict_error}"
            );
            let relaxed_connector = postgres_connector(true)
                .map_err(|error| format!("failed to build TLS: {error}"))?;
            config
                .connect(relaxed_connector)
                .map_err(|error| format!("failed to connect to database: {error}"))
        }
    }
}

fn applied_versions(client: &mut Client) -> Result<Vec<String>, String> {
    let rows = client
        .query(
            "select version from public.schema_migrations order by version asc",
            &[],
        )
        .map_err(|error| format!("failed to query schema_migrations: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect())
}

fn read_migration_file(path: &Path, version: &str, name: &str) -> Result<MigrationFile, String> {
    let sql = fs::read_to_string(path)
        .map_err(|error| format!("failed to read migration {}: {error}", path.display()))?;
    Ok(MigrationFile {
        version: version.to_string(),
        name: name.to_string(),
        sql,
        path: path.to_path_buf(),
    })
}

fn repo_root() -> Result<PathBuf, String> {
    let mut current = env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?;
    loop {
        if current.join("Cargo.toml").exists() && current.join("apps").exists() {
            return Ok(current);
        }
        if !current.pop() {
            return Err("failed to locate repository root".to_string());
        }
    }
}

fn checksum(input: &str) -> String {
    let mut state: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        state ^= u64::from(*byte);
        state = state.wrapping_mul(0x100000001b3);
    }
    format!("{state:016x}")
}

fn postgres_connector(relaxed: bool) -> Result<MakeTlsConnector, native_tls::Error> {
    let mut builder = TlsConnector::builder();
    if relaxed {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder.build().map(MakeTlsConnector::new)
}

fn db_error_message(error: &postgres::Error) -> String {
    if let Some(db_error) = error.as_db_error() {
        let mut message = db_error.message().to_string();
        if let Some(detail) = db_error.detail() {
            message.push_str(&format!(" | detail: {detail}"));
        }
        if let Some(hint) = db_error.hint() {
            message.push_str(&format!(" | hint: {hint}"));
        }
        message.push_str(&format!(" | code: {}", db_error.code().code()));
        message
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn migration_files_prefer_postgres_directory() {
        let root = test_root("prefer-postgres");
        fs::create_dir_all(root.join("db/migrations")).expect("db migrations dir");
        fs::create_dir_all(root.join("supabase/migrations")).expect("legacy migrations dir");
        fs::write(root.join("db/schema.sql"), "-- db schema").expect("db schema");
        fs::write(
            root.join("db/migrations/0001_managed.sql"),
            "-- managed migration",
        )
        .expect("managed migration");
        fs::write(root.join("supabase/schema.sql"), "-- legacy schema").expect("legacy schema");
        fs::write(
            root.join("supabase/migrations/0001_legacy.sql"),
            "-- legacy migration",
        )
        .expect("legacy migration");

        let files = migration_files_in_root(&root).expect("migration files");

        assert_eq!(files.len(), 2);
        let db_dir = root.join("db");
        assert!(files.iter().all(|file| file.path.starts_with(&db_dir)));
        assert!(files.iter().any(|file| file.name == "managed"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn migration_files_fall_back_to_legacy_supabase_directory() {
        let root = test_root("legacy-fallback");
        fs::create_dir_all(root.join("supabase/migrations")).expect("legacy migrations dir");
        fs::write(root.join("supabase/schema.sql"), "-- legacy schema").expect("legacy schema");
        fs::write(
            root.join("supabase/migrations/0001_legacy.sql"),
            "-- legacy migration",
        )
        .expect("legacy migration");

        let files = migration_files_in_root(&root).expect("migration files");

        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .all(|file| file.path.to_string_lossy().contains("supabase")));
        assert!(files.iter().any(|file| file.name == "legacy"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    fn test_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mundusx-migration-{name}-{unique}"));
        fs::create_dir_all(&root).expect("test root");
        root
    }
}
