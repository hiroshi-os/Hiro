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

    // Launch chrome browser headfully (visible)
    let browser = Browser::new(
        LaunchOptions::default_builder()
            .headless(false)
            .window_size(Some((1280, 800)))
            .build()
            .map_err(|e| format!("Failed to build headful launch config: {:?}", e))?
    ).map_err(|e| format!("Browser launch failed: {:?}", e))?;

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
    let element = tab.wait_for_element(selector)
        .map_err(|e| format!("DOM selector '{}' timed out: {:?}", selector, e))?;
    element.click().map_err(|e| format!("Click dispatch failed: {:?}", e))?;
    Ok(())
}

pub async fn browser_type(selector: &str, text: &str) -> Result<(), String> {
    let tab = get_or_create_tab().await?;
    let element = tab.wait_for_element(selector)
        .map_err(|e| format!("DOM selector '{}' timed out: {:?}", selector, e))?;
    element.click().map_err(|e| format!("Failed to focus element for typing: {:?}", e))?;
    element.type_into(text).map_err(|e| format!("Typing dispatch failed: {:?}", e))?;
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
