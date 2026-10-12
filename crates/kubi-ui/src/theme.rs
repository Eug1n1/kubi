use eframe::egui::{self, Color32, CornerRadius, FontId, RichText, Stroke, Vec2};

pub const CHROME: Color32 = Color32::from_rgb(50, 50, 50);
pub const DOCK: Color32 = Color32::from_rgb(30, 30, 30);
pub const CARD: Color32 = Color32::from_rgb(50, 50, 50);
pub const FIELD: Color32 = Color32::from_rgb(36, 36, 36);
pub const TAB_STRIP: Color32 = Color32::from_rgb(38, 38, 38);
pub const TEXT: Color32 = Color32::from_rgb(222, 222, 222);
pub const TEXT_DIM: Color32 = Color32::from_rgb(178, 178, 178);
pub const ACCENT: Color32 = Color32::from_rgb(55, 142, 240);
pub const OK: Color32 = Color32::from_rgb(106, 176, 122);
pub const WARN: Color32 = Color32::from_rgb(232, 176, 70);
pub const BAD: Color32 = Color32::from_rgb(236, 91, 98);
pub const MUTED: Color32 = TEXT_DIM;
pub const ROW_SELECTED: Color32 = Color32::from_rgb(82, 82, 82);
pub const HOVER: Color32 = Color32::from_rgb(66, 66, 66);
pub const SEPARATOR: Color32 = Color32::from_rgb(62, 62, 62);

pub fn apply(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = DOCK;
    visuals.window_fill = CARD;
    visuals.window_stroke = Stroke::new(1.0, DOCK);
    visuals.extreme_bg_color = FIELD;
    visuals.faint_bg_color = CARD;
    visuals.code_bg_color = FIELD;
    visuals.hyperlink_color = ACCENT;
    visuals.warn_fg_color = WARN;
    visuals.error_fg_color = BAD;
    visuals.selection.bg_fill = ROW_SELECTED;
    visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    visuals.window_corner_radius = CornerRadius::same(4);
    visuals.menu_corner_radius = CornerRadius::same(4);
    visuals.striped = false;
    let radius = CornerRadius::same(3);
    let widgets = &mut visuals.widgets;
    widgets.noninteractive.bg_fill = CARD;
    widgets.noninteractive.weak_bg_fill = CARD;
    widgets.noninteractive.bg_stroke = Stroke::new(1.0, SEPARATOR);
    widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_DIM);
    widgets.noninteractive.corner_radius = radius;
    for (widget, fill, stroke) in [
        (&mut widgets.inactive, FIELD, Color32::from_rgb(74, 74, 74)),
        (
            &mut widgets.hovered,
            Color32::from_rgb(66, 66, 66),
            Color32::from_rgb(74, 74, 74),
        ),
        (&mut widgets.active, Color32::from_rgb(78, 78, 78), ACCENT),
        (
            &mut widgets.open,
            Color32::from_rgb(66, 66, 66),
            Color32::from_rgb(74, 74, 74),
        ),
    ] {
        widget.bg_fill = fill;
        widget.weak_bg_fill = fill;
        widget.bg_stroke = Stroke::new(1.0, stroke);
        widget.fg_stroke = Stroke::new(1.0, TEXT);
        widget.corner_radius = radius;
        widget.expansion = 0.0;
    }
    visuals.override_text_color = Some(TEXT);
    ctx.set_visuals(visuals);
    ctx.all_styles_mut(|style| {
        style
            .text_styles
            .insert(egui::TextStyle::Small, FontId::proportional(10.5));
        style
            .text_styles
            .insert(egui::TextStyle::Body, FontId::proportional(12.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, FontId::proportional(12.0));
        style
            .text_styles
            .insert(egui::TextStyle::Heading, FontId::proportional(15.0));
        style
            .text_styles
            .insert(egui::TextStyle::Monospace, FontId::monospace(12.0));
        style.spacing.item_spacing = Vec2::new(8.0, 6.0);
        style.spacing.button_padding = Vec2::new(10.0, 4.0);
        style.spacing.interact_size = Vec2::new(24.0, 24.0);
        let mut scroll = egui::style::ScrollStyle::solid();
        scroll.bar_width = 8.0;
        scroll.bar_inner_margin = 0.0;
        scroll.bar_outer_margin = 0.0;
        scroll.foreground_color = true;
        scroll.dormant_background_opacity = 0.0;
        scroll.dormant_handle_opacity = 0.55;
        scroll.active_handle_opacity = 0.8;
        style.spacing.scroll = scroll;
        style.visuals.indent_has_left_vline = false;
    });
}

pub fn tone_color(tone: kubi_core::StatusTone) -> Color32 {
    match tone {
        kubi_core::StatusTone::Ok => OK,
        kubi_core::StatusTone::Warn => WARN,
        kubi_core::StatusTone::Bad => BAD,
        kubi_core::StatusTone::Neutral => MUTED,
    }
}

pub fn section_label(text: &str) -> RichText {
    RichText::new(text).size(13.0).color(TEXT_DIM).strong()
}

pub fn edge_frame(ui: &egui::Ui, fill: Color32) -> egui::Frame {
    egui::Frame::side_top_panel(ui.style())
        .fill(fill)
        .inner_margin(0)
        .stroke(Stroke::new(1.0, SEPARATOR))
}
