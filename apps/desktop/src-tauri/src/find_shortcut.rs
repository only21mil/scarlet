use tauri::Manager;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2Controller,
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    },
    AcceleratorKeyPressedEventHandler,
};
use windows::{
    Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_F, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    },
    core::Interface,
};

pub(crate) fn forward_to_renderer(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(err) = window.with_webview(|webview| {
        if let Err(err) = forward_find(&webview.controller()) {
            log::warn!("Could not set up Ctrl+F in the webview: {err}");
        }
    }) {
        log::warn!("Could not access the webview to set up Ctrl+F: {err}");
    }
}

fn forward_find(controller: &ICoreWebView2Controller) -> windows::core::Result<()> {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut key = 0;
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
        // WebView2 processes Ctrl+F before the DOM. Disable its Find action for this chord
        // and let the original key event reach the renderer.
        unsafe {
            args.VirtualKey(&mut key)?;
            if key != u32::from(VK_F.0) || !key_is_down(VK_CONTROL) {
                return Ok(());
            }
            args.KeyEventKind(&mut kind)?;
            if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                && ![VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                    .into_iter()
                    .any(key_is_down)
            {
                args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()?
                    .SetIsBrowserAcceleratorKeyEnabled(false)?;
            }
        }
        Ok(())
    }));
    let mut token = 0;
    // The controller owns the handler for the lifetime of the main webview.
    unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
}

fn key_is_down(key: VIRTUAL_KEY) -> bool {
    // The high bit is the state of the key for the current keyboard message.
    unsafe { GetKeyState(i32::from(key.0)) < 0 }
}
