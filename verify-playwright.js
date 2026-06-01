const { chromium } = require('playwright');

(async () => {
  console.log('Iniciando verificacion de Playwright...');

  try {
    const browser = await chromium.launch({ headless: true });
    console.log('✅ Chromium lanzado correctamente');

    const context = await browser.newContext();
    const page = await context.newPage();

    // Test 1: Landing page
    console.log('\n📄 Test 1: Landing Page');
    await page.goto('file:///C:/proyectos_personales/Bandait/landing/index.html');
    const title = await page.title();
    console.log(`   Titulo: ${title}`);
    console.log(`   ✅ Titulo correcto: ${title.includes('Bandait')}`);

    const heroText = await page.locator('h1').textContent();
    console.log(`   Hero: ${heroText?.substring(0, 50)}...`);

    // Test 2: Leader Web (si esta corriendo)
    console.log('\n🎛️  Test 2: Leader Web App');
    try {
      await page.goto('http://localhost:5173', { timeout: 5000 });
      const leaderContent = await page.locator('body').textContent();
      console.log(`   ✅ Leader web responde`);
      console.log(`   Contenido: ${leaderContent?.substring(0, 100)}...`);
    } catch (e) {
      console.log(`   ⚠️  Leader web no disponible (servidor no corriendo)`);
    }

    // Test 3: Follower (si esta corriendo)
    console.log('\n📱 Test 3: Follower App');
    try {
      await page.goto('http://localhost:5174', { timeout: 5000 });
      const followerContent = await page.locator('body').textContent();
      console.log(`   ✅ Follower responde`);
      console.log(`   Contenido: ${followerContent?.substring(0, 100)}...`);
    } catch (e) {
      console.log(`   ⚠️  Follower no disponible (servidor no corriendo)`);
    }

    await browser.close();
    console.log('\n✅ Verificacion completada. Playwright funciona correctamente.');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
})();
