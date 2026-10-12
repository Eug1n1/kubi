pub fn format_age(secs: u64) -> String {
    const MIN: u64 = 60;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;
    if secs < MIN {
        format!("{secs}s")
    } else if secs < HOUR {
        format!("{}m", secs / MIN)
    } else if secs < DAY {
        format!("{}h", secs / HOUR)
    } else if secs < 365 * DAY {
        format!("{}d", secs / DAY)
    } else {
        format!("{}y", secs / (365 * DAY))
    }
}

pub fn parse_cpu_millis(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(n) = raw.strip_suffix('n') {
        return parse_f64(n).map(|v| v / 1_000_000.0);
    }
    if let Some(n) = raw.strip_suffix('u') {
        return parse_f64(n).map(|v| v / 1_000.0);
    }
    if let Some(n) = raw.strip_suffix('m') {
        return parse_f64(n);
    }
    parse_f64(raw).map(|cores| cores * 1000.0)
}

pub fn format_cpu(millis: f64) -> String {
    if millis >= 1000.0 {
        let cores = millis / 1000.0;
        if (cores - cores.round()).abs() < 0.05 {
            format!("{cores:.0}")
        } else {
            format!("{cores:.2}")
        }
    } else if millis >= 10.0 {
        format!("{millis:.0}m")
    } else {
        format!("{millis:.1}m")
    }
}

pub fn format_cpu_pair(usage: Option<f64>, request: Option<f64>) -> String {
    match (usage, request) {
        (Some(u), Some(r)) => format!("{} / {}", format_cpu(u), format_cpu(r)),
        (Some(u), None) => format_cpu(u),
        (None, Some(r)) => format!("- / {}", format_cpu(r)),
        (None, None) => "-".to_string(),
    }
}

pub fn parse_bytes(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    const UNITS: &[(&str, f64)] = &[
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Ei", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("K", 1000.0),
        ("M", 1000.0 * 1000.0),
        ("G", 1000.0 * 1000.0 * 1000.0),
        ("T", 1000.0 * 1000.0 * 1000.0 * 1000.0),
        ("k", 1000.0),
    ];
    for (suffix, mul) in UNITS {
        if let Some(n) = raw.strip_suffix(suffix) {
            return parse_f64(n).map(|v| v * mul);
        }
    }
    parse_f64(raw)
}

pub fn format_bytes(bytes: f64) -> String {
    const UNITS: &[(&str, f64)] = &[
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Ki", 1024.0),
    ];
    for (suffix, mul) in UNITS {
        if bytes >= *mul {
            let v = bytes / mul;
            if v >= 10.0 {
                return format!("{v:.0}{suffix}");
            }
            return format!("{v:.1}{suffix}");
        }
    }
    format!("{bytes:.0}B")
}

pub fn format_bytes_pair(usage: Option<f64>, request: Option<f64>) -> String {
    match (usage, request) {
        (Some(u), Some(r)) => format!("{} / {}", format_bytes(u), format_bytes(r)),
        (Some(u), None) => format_bytes(u),
        (None, Some(r)) => format!("- / {}", format_bytes(r)),
        (None, None) => "-".to_string(),
    }
}

fn parse_f64(raw: &str) -> Option<f64> {
    let n: f64 = raw.trim().parse().ok()?;
    n.is_finite().then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu() {
        assert_eq!(parse_cpu_millis("1"), Some(1000.0));
        assert_eq!(parse_cpu_millis("500m"), Some(500.0));
        assert_eq!(parse_cpu_millis("1000u"), Some(1.0));
        assert_eq!(parse_cpu_millis("1000000n"), Some(1.0));
    }

    #[test]
    fn parses_memory() {
        assert_eq!(parse_bytes("1024"), Some(1024.0));
        assert_eq!(parse_bytes("1Ki"), Some(1024.0));
        assert_eq!(parse_bytes("1Mi"), Some(1024.0 * 1024.0));
        assert_eq!(parse_bytes("1.5Gi"), Some(1.5 * 1024.0 * 1024.0 * 1024.0));
    }

    #[test]
    fn formats_age_units() {
        assert_eq!(format_age(12), "12s");
        assert_eq!(format_age(120), "2m");
        assert_eq!(format_age(7200), "2h");
        assert_eq!(format_age(3 * 24 * 3600), "3d");
    }

    #[test]
    fn formats_pairs() {
        assert_eq!(format_cpu_pair(Some(250.0), Some(500.0)), "250m / 500m");
        assert_eq!(format_cpu_pair(None, None), "-");
        assert_eq!(format_bytes_pair(Some(1024.0 * 1024.0), None), "1.0Mi");
    }
}
