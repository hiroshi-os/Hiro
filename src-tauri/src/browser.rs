use std::sync::Arc;
use lazy_static::lazy_static;
use tokio::sync::Mutex;
use headless_chrome::{Browser, LaunchOptions, Tab};

lazy_static! {
    static ref BROWSER_TAB: Arc<Mutex<Option<Arc<Tab>>>> = Arc::new(Mutex::new(None));
}

async fn get_or_create_tab() -> Result<Arc<Tab>, String> {
    let mut lock = BROWSER_TAB.lock().await;
    if let Some(tab) = &*lock {
        return Ok(tab.clone());
    }

    // Launch chrome browser headlessly
    let browser = Browser::new(
        LaunchOptions::default_builder()
            .headless(true)
            .build()
            .map_err(|e| format!("Failed to build LaunchOptions: {}", e))?
    ).map_err(|e| format!("Failed to launch headless chrome: {}", e))?;

    let tab = browser.new_tab().map_err(|e| format!("Failed to create tab: {}", e))?;
    
    // Leak browser to keep process alive in memory
    Box::leak(Box::new(browser));

    *lock = Some(tab.clone());
    Ok(tab)
}

pub async fn browser_goto(url: &str) -> Result<(), String> {
    let tab = get_or_create_tab().await?;
    tab.navigate_to(url).map_err(|e| format!("Navigation failed: {}", e))?;
    tab.wait_until_navigated().map_err(|e| format!("Navigation wait failed: {}", e))?;
    Ok(())
}

pub async fn browser_click(selector: &str) -> Result<(), String> {
    let tab = get_or_create_tab().await?;
    // Wait for element first
    let _ = tab.wait_for_element(selector).map_err(|e| format!("Element not found: {}", e))?;
    let js = format!("document.querySelector('{}').click()", selector);
    let _ = tab.evaluate(&js, true).map_err(|e| format!("Click execution failed: {}", e))?;
    Ok(())
}

pub async fn browser_type(selector: &str, text: &str) -> Result<(), String> {
    let tab = get_or_create_tab().await?;
    let _ = tab.wait_for_element(selector).map_err(|e| format!("Element not found: {}", e))?;
    // Escape single quotes in text to prevent JS syntax error
    let escaped_text = text.replace('\'', "\\'");
    let js = format!(
        "let el = document.querySelector('{}'); el.focus(); el.value = '{}'; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }}));",
        selector, escaped_text
    );
    let _ = tab.evaluate(&js, true).map_err(|e| format!("Type execution failed: {}", e))?;
    Ok(())
}

pub async fn browser_extract(selector: &str) -> Result<String, String> {
    let tab = get_or_create_tab().await?;
    let _ = tab.wait_for_element(selector).map_err(|e| format!("Element not found: {}", e))?;
    let js = format!("document.querySelector('{}').innerText", selector);
    let value = tab.evaluate(&js, true).map_err(|e| format!("Extract execution failed: {}", e))?;
    
    // Retrieve text value from headless_chrome ReturnValue
    if let Some(val) = value.value {
        if let serde_json::Value::String(s) = val {
            return Ok(s);
        }
        return Ok(val.to_string());
    }
    Err("No text extracted from element".into())
}
