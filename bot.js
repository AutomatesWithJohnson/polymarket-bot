const axios = require('axios');

// ============== CONFIG ==============
const CONFIG = {
  graphqlEndpoint: 'https://clob.polymarket.com/graphql',
  
  // Strategy 1: NO positions (probability harvesting)
  minProbabilityNO: 1,
  maxProbabilityNO: 10,
  
  // Strategy 2: YES positions (high confidence)
  minProbabilityYES: 85,
  maxProbabilityYES: 98,
  
  // Bet settings
  betSize: 1,
  maxBetsPerDay: 20,
  
  // NEW: Safety filters
  minVolume: 100,           // Minimum $100 volume to trust the probability
  minLiquidity: 50,         // Minimum $50 liquidity to actually place bet
  maxDaysToSettle: 30,      // Skip markets settling > 30 days away (want fast turnover)
  
  // NEW: Niche filters (enable what you want)
  niches: {
    sports: false,   // Set true to focus on sports
    politics: false, // Set true to focus on politics  
    crypto: false,   // Set true to focus on crypto
  }
};

// ============== STATE ==============
let bets = [];
let dailyBetCount = 0;
let previousPrices = {}; // Track price history for confidence

// ============== POLYMARKET API ==============
async function getMarkets() {
  const query = `
    query GetMarkets {
      markets(
        limit: 100
        closed: false
      ) {
        id
        question
        description
        slug
        volume
        liquidity
        startDate
        endDate
        categories
        outcomePrices
        outcomeNames
      }
    }
  `;
  
  try {
    const response = await axios.post(CONFIG.graphqlEndpoint, { query }, {
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data?.data?.markets || [];
  } catch (error) {
    console.log('Error fetching markets:', error.message);
    return [];
  }
}

// ============== SAFETY CHECKS ==============
function passesSafetyChecks(market, outcome) {
  const volume = parseFloat(market.volume || 0);
  const liquidity = parseFloat(market.liquidity || 0);
  
  // Check volume
  if (volume < CONFIG.minVolume) {
    return { pass: false, reason: `Low volume: $${volume} (need $${CONFIG.minVolume}+)` };
  }
  
  // Check liquidity
  if (liquidity < CONFIG.minLiquidity) {
    return { pass: false, reason: `Low liquidity: $${liquidity} (need $${CONFIG.minLiquidity}+)` };
  }
  
  // Check settlement date
  const daysUntilSettle = (new Date(market.endDate) - new Date()) / (1000 * 60 * 60 * 24);
  if (daysUntilSettle > CONFIG.maxDaysToSettle) {
    return { pass: false, reason: `Settles in ${daysUntilSettle.toFixed(0)} days (too long)` };
  }
  
  // Check niche filters
  const categories = (market.categories || []).map(c => c.toLowerCase());
  
  if (CONFIG.niches.sports && !categories.some(c => c.includes('sport'))) {
    return { pass: false, reason: 'Not a sports market' };
  }
  if (CONFIG.niches.politics && !categories.some(c => c.includes('polit'))) {
    return { pass: false, reason: 'Not a politics market' };
  }
  if (CONFIG.niches.crypto && !categories.some(c => c.includes('crypto') || c.includes('bitcoin'))) {
    return { pass: false, reason: 'Not a crypto market' };
  }
  
  return { pass: true };
}

// ============== CONFIDENCE CHECK ==============
function getConfidenceScore(marketId, currentPrice) {
  // Check if we've seen this market before
  if (!previousPrices[marketId]) {
    previousPrices[marketId] = [];
  }
  
  const history = previousPrices[marketId];
  history.push({ price: currentPrice, time: Date.now() });
  
  // Keep last 6 readings (30 minutes at 5-min intervals)
  if (history.length > 6) history.shift();
  
  if (history.length < 3) return 100; // Can't calculate, assume confident
  
  // Check price stability
  const prices = history.map(h => h.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  
  // Lower stdDev = more stable = higher confidence
  // If stdDev > 10%, it's volatile
  const confidence = Math.max(0, 100 - (stdDev * 5));
  
  return confidence;
}

// ============== STRATEGY 1: NO POSITIONS ==============
function findNoValueBets(markets) {
  const opportunities = [];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    
    const outcomes = market.outcomeNames.map((name, i) => ({
      name,
      price: parseFloat(market.outcomePrices[i]) * 100
    }));
    
    const noOutcome = outcomes.find(o => 
      o.name.toLowerCase() === 'no' || o.name.toLowerCase() === 'negative'
    );
    
    if (!noOutcome) continue;
    
    if (noOutcome.price >= CONFIG.minProbabilityNO && 
        noOutcome.price <= CONFIG.maxProbabilityNO) {
      
      // Run safety checks
      const safety = passesSafetyChecks(market, noOutcome);
      if (!safety.pass) continue;
      
      // Check confidence
      const confidence = getConfidenceScore(market.id, noOutcome.price);
      if (confidence < 50) continue; // Skip volatile markets
      
      const payout = (CONFIG.betSize / (noOutcome.price / 100)) - CONFIG.betSize;
      
      opportunities.push({
        id: market.id,
        type: 'NO',
        question: market.question,
        probability: noOutcome.price,
        volume: market.volume,
        liquidity: market.liquidity,
        daysToSettle: Math.ceil((new Date(market.endDate) - new Date()) / (1000 * 60 * 60 * 24)),
        potentialWin: payout,
        expectedValue: (noOutcome.price / 100) * payout - ((100 - noOutcome.price) / 100) * CONFIG.betSize,
        confidence,
        url: `https://polymarket.com/market/${market.slug || market.id}`
      });
    }
  }
  
  return opportunities;
}

// ============== STRATEGY 2: YES POSITIONS ==============
function findYesValueBets(markets) {
  const opportunities = [];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    
    const outcomes = market.outcomeNames.map((name, i) => ({
      name,
      price: parseFloat(market.outcomePrices[i]) * 100
    }));
    
    const yesOutcome = outcomes.find(o => 
      o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'positive'
    );
    
    if (!yesOutcome) continue;
    
    if (yesOutcome.price >= CONFIG.minProbabilityYES && 
        yesOutcome.price <= CONFIG.maxProbabilityYES) {
      
      // Run safety checks
      const safety = passesSafetyChecks(market, yesOutcome);
      if (!safety.pass) continue;
      
      // Check confidence
      const confidence = getConfidenceScore(market.id, yesOutcome.price);
      if (confidence < 50) continue;
      
      const payout = (CONFIG.betSize / (yesOutcome.price / 100)) - CONFIG.betSize;
      
      opportunities.push({
        id: market.id,
        type: 'YES',
        question: market.question,
        probability: yesOutcome.price,
        volume: market.volume,
        liquidity: market.liquidity,
        daysToSettle: Math.ceil((new Date(market.endDate) - new Date()) / (1000 * 60 * 60 * 24)),
        potentialWin: payout,
        expectedValue: (yesOutcome.price / 100) * payout - ((100 - yesOutcome.price) / 100) * CONFIG.betSize,
        confidence,
        url: `https://polymarket.com/market/${market.slug || market.id}`
      });
    }
  }
  
  return opportunities;
}

// ============== MAIN ==============
async function runStrategy() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎲 POLYMARKET BOT v3.0 - ${new Date().toLocaleString()}`);
  console.log('='.repeat(70));
  
  if (dailyBetCount >= CONFIG.maxBetsPerDay) {
    console.log(`⚠️ Daily limit: ${dailyBetCount}/${CONFIG.maxBetsPerDay}`);
    return;
  }
  
  console.log(`\n🔍 Scanning markets with safety filters...`);
  
  const markets = await getMarkets();
  console.log(`📊 Found ${markets.length} active markets`);
  
  const noBets = findNoValueBets(markets);
  const yesBets = findYesValueBets(markets);
  
  console.log(`\n🎯 Opportunities:`);
  console.log(`   NO (1-10%): ${noBets.length} | YES (85-98%): ${yesBets.length}`);
  
  if (noBets.length > 0) {
    console.log(`\n🔥 TOP NO OPPORTUNITIES:`);
    noBets.sort((a, b) => b.expectedValue - a.expectedValue).slice(0, 3).forEach(b => {
      console.log(`   ${b.type}: ${b.question.substring(0, 40)}`);
      console.log(`      ${b.probability.toFixed(1)}% | $${b.volume} vol | ${b.daysToSettle}d | Conf: ${b.confidence}%`);
    });
  }
  
  if (yesBets.length > 0) {
    console.log(`\n🔥 TOP YES OPPORTUNITIES:`);
    yesBets.sort((a, b) => b.expectedValue - a.expectedValue).slice(0, 3).forEach(b => {
      console.log(`   ${b.type}: ${b.question.substring(0, 40)}`);
      console.log(`      ${b.probability.toFixed(1)}% | $${b.volume} vol | ${b.daysToSettle}d | Conf: ${b.confidence}%`);
    });
  }
  
  const allOpportunities = [
    ...noBets.map(b => ({...b, priority: 1})),
    ...yesBets.map(b => ({...b, priority: 2}))
  ];
  
  allOpportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  
  if (allOpportunities.length > 0) {
    const best = allOpportunities[0];
    console.log(`\n🏆 BEST PICK:`);
    console.log(`   ${best.type}: ${best.question}`);
    console.log(`   Probability: ${best.probability.toFixed(1)}% | Confidence: ${best.confidence}%`);
    console.log(`   Volume: $${best.volume} | Settles: ${best.daysToSettle} days`);
    console.log(`   Expected Value: $${best.expectedValue.toFixed(2)}`);
    console.log(`   🔗 ${best.url}`);
    
    bets.push({ ...best, amount: CONFIG.betSize, placedAt: new Date().toISOString() });
    dailyBetCount++;
  } else {
    console.log(`\n⏳ No opportunities meet all criteria`);
  }
  
  console.log(`\n📈 Today: ${dailyBetCount}/${CONFIG.maxBetsPerDay} bets`);
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         🎲 POLYMARKET BOT v3.0                                ║
║         With Safety Filters & Confidence Scoring              ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  console.log(`⚙️ Filters:`);
  console.log(`   Min Volume: $${CONFIG.minVolume}`);
  console.log(`   Min Liquidity: $${CONFIG.minLiquidity}`);
  console.log(`   Max Days to Settle: ${CONFIG.maxDaysToSettle}`);
  console.log(`   NO: ${CONFIG.minProbabilityNO}-${CONFIG.maxProbabilityNO}%`);
  console.log(`   YES: ${CONFIG.minProbabilityYES}-${CONFIG.maxProbabilityYES}%`);
  
  runStrategy();
  setInterval(runStrategy, 5 * 60 * 1000);
}

main().catch(console.error);
