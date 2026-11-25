use std::path::PathBuf;
fn main() {
    let mut args = std::env::args().skip(1);
    let mut validate = false;
    let mut manifest = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--validate" if !validate => validate = true,
            "--manifest" if manifest.is_none() => manifest = args.next().map(PathBuf::from),
            _ => {
                eprintln!("usage: pi-sandbox-service [--validate] --manifest FILE");
                std::process::exit(2)
            }
        }
    }
    let result = (|| {
        let path = manifest.ok_or_else(|| "--manifest FILE is required".to_string())?;
        let manifest = pi_sandbox_service::Manifest::load(&path).map_err(|e| e.to_string())?;
        if validate {
            pi_sandbox_service::validate(&manifest).map_err(|e| e.to_string())
        } else {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?
                .block_on(pi_sandbox_service::run(manifest))
                .map_err(|e| e.to_string())
        }
    })();
    if let Err(error) = result {
        eprintln!("pi-sandbox-service: {error}");
        std::process::exit(1)
    }
}
