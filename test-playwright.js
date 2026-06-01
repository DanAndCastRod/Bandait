const { chromium } = require('playwright');

(async () => {
  console.log('Iniciando prueba de Playwright...');
  
  try {
    // Lanzar navegador
    const browser = await chromium.launch({ headless: true });
    console.log('✓ Navegador Chromium lanzado correctamente');
    
    // Crear contexto y página
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log('✓ Contexto y página creados');
    
    // Navegar a una página de prueba
    await page.goto('https://playwright.dev');
    console.log('✓ Navegación exitosa a playwright.dev');
    
    // Verificar título
    const title = await page.title();
    console.log(`✓ Título de la página: "${title}"`);
    
    // Tomar screenshot
    await page.screenshot({ path: 'playwright-test.png' });
    console.log('✓ Screenshot guardado como playwright-test.png');
    
    // Cerrar navegador
    await browser.close();
    console.log('✓ Navegador cerrado correctamente');
    
    console.log('\n✅ Playwright está funcionando correctamente');
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
})();
