fn main() {
    if let Err(err) = kubi_ui::run() {
        eprintln!("kubi: {err}");
        std::process::exit(1);
    }
}
