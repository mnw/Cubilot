// Prevents additional console window on Windows in release, do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `cubilot hub <METHOD> <path> [json-body]` runs one hub request from Terminal; any other start opens the app.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("hub") {
        std::process::exit(cubilot_lib::cli::run_from_env(&args[1..]));
    }
    cubilot_lib::run()
}
