const axios = require('axios');

// ============== CONFIG ==============
const CONFIG = {
  graphqlEndpoint: 'https://clob.polymarket.com/graphql',
  
  // Strategy: Three main approaches
  // 1. NO positions on near-zero probability (probability harvesting)
  minProbabilityNO: 1,    // Very low % = high chance to win
  maxProbabilityNO: 10,   // 1-10% probability
  
  // 2. YES positions on high probability (value bets)
  minProbabilityYES: 75,  // 75%+ probability
  maxProbabilityYES: 98,
  
  // 3. Logical arbitrage - watch for correlated markets
  betSize: 1, // Start small!
  maxBetsPerDay: 20,
  
  // Exit strategies
  takeProfitPercent: 50, // Take 50% profit if position is up
  stopLossPercent: 25,   // Stop at 25% loss
};

// ============== STATE ==============
let bets = [];
let dailyBetCount = 0;
let totalProfit = 0;

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

// ============== STRATEGY 1: NO POSITIONS (Probability Harvesting) ==============
// Target outcomes with 1-10% probability = 90-99% chance of winning
function findNoValueBets(markets) {
  const opportunities = [];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    if (new Date(market.endDate) < new Date()) continue;
    
    const outcomes = market.outcomeNames.map((name, i) => ({
      name,
      price: parseFloat(market.outcomePrices[i]) * 100
    }));
    
    // Find NO outcome
    const noOutcome = outcomes.find(o => 
      o.name.toLowerCase() === 'no' || 
      o.name.toLowerCase() === 'negative'
    );
    
    if (!noOutcome) continue;
    
    // NO position with 1-10% price = 90-99% chance of winning
    if (noOutcome.price >= CONFIG.minProbabilityNO && 
        noOutcome.price <= CONFIG.maxProbabilityNO) {
      
      const payout = (CONFIG.betSize / (noOutcome.price / 100)) - CONFIG.betSize;
      
      opportunities.push({
        id: market.id,
        type: 'NO',
        question: market.question,
        probability: noOutcome.price,
        potentialWin: payout,
        expectedValue: (noOutcome.price / 100) * payout - ((100 - noOutcome.price) / 100) * CONFIG.betSize,
        endDate: market.endDate,
        url: `https://polymarket.com/market/${market.slug || market.id}`
      });
    }
  }
  
  return opportunities;
}

// ============== STRATEGY 2: YES POSITIONS (Value Bets) ==============
function findYesValueBets(markets) {
  const opportunities = [];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    if (new Date(market.endDate) < new Date()) continue;
    
    const outcomes = market.outcomeNames.map((name, i) => ({
      name,
      price: parseFloat(market.outcomePrices[i]) * 100
    }));
    
    // Find YES outcome
    const yesOutcome = outcomes.find(o => 
      o.name.toLowerCase() === 'yes' || 
      o.name.toLowerCase() === 'positive'
    );
    
    if (!yesOutcome) continue;
    
    // YES position with 75-98% probability = high confidence
    if (yesOutcome.price >= CONFIG.minProbabilityYES && 
        yesOutcome.price <= CONFIG.maxProbabilityYES) {
      
      const payout = (CONFIG.betSize / (yesOutcome.price / 100)) - CONFIG.betSize;
      
      opportunities.push({
        id: market.id,
        type: 'YES',
        question: market.question,
        probability: yesOutcome.price,
        potentialWin: payout,
        expectedValue: (yesOutcome.price / 100) * payout - ((100 - yesOutcome.price) / 100) * CONFIG.betSize,
        endDate: market.endDate,
        url: `https://polymarket.com/market/${market.slug || market.id}`
      });
    }
  }
  
  return opportunities;
}

// ============== STRATEGY 3: LOGICAL ARBITRAGE ==============
// Find markets where one outcome implies another
function findArbitrageOpportunities(markets) {
  const opportunities = [];
  
  // Look for correlated keywords
  const correlations = [
    { keywords: ['trump', 'republican'], implies: 'Republican wins' },
    { keywords: ['biden', 'democrat'], implies: 'Democrat wins' },
    { keywords: ['bitcoin', 'btc', '100k'], implies: 'Bitcoin higher' },
    { keywords: ['rate', 'fed', 'cut'], implies: 'Rate cut' },
  ];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    if (new Date(market.endDate) < new Date()) continue;
    
    const question = market.question.toLowerCase();
    const desc = (market.description || '').toLowerCase();
    const combined = question + ' ' + desc;
    
    for (const corr of correlations) {
      if (corr.keywords.some(k => combined.includes(k))) {
        const outcomes = market.outcomeNames.map((name, i) => ({
          name,
          price: parseFloat(market.outcomePrices[i]) * 100
        }));
        
        const yesOutcome = outcomes.find(o => 
          o.name.toLowerCase().includes('yes')
        );
        
        if (yesOutcome && yesOutcome.price > 60 && yesOutcome.price < 90) {
          opportunities.push({
            id: market.id,
            type: 'ARBITRAGE',
            question: market.question,
            probability: yesOutcome.price,
            note: `Correlated with: ${corr.implies}`,
            potentialWin: (CONFIG.betSize * 2 / (yesOutcome.price / 100)) - CONFIG.betSize * 2,
            endDate: market.endDate,
            url: `https://polymarket.com/market/${market.slug || market.id}`
          });
        }
      }
    }
  }
  
  return opportunities;
}

// ============== MAIN STRATEGY ==============
async function runStrategy() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎲 POLYMARKET ALPHA BOT - ${new Date().toLocaleString()}`);
  console.log('='.repeat(70));
  
  if (dailyBetCount >= CONFIG.maxBetsPerDay) {
    console.log(`⚠️ Daily limit: ${dailyBetCount}/${CONFIG.maxBetsPerDay}`);
    return;
  }
  
  console.log(`\n🔍 Scanning markets...`);
  
  const markets = await getMarkets();
  console.log(`📊 Found ${markets.length} active markets`);
  
  // Strategy 1: NO positions (probability harvesting)
  const noBets = findNoValueBets(markets);
  console.log(`\n🎯 Strategy 1 - NO Positions (${noBets.length} found):`);
  noBets.slice(0, 3).forEach(b => {
    console.log(`   ${b.type}: ${b.question.substring(0, 40)}...`);
    console.log(`      Probability: ${b.probability.toFixed(1)}% | Win: $${b.potentialWin.toFixed(2)}`);
  });
  
  // Strategy 2: YES positions (value bets)
  const yesBets = findYesValueBets(markets);
  console.log(`\n🎯 Strategy 2 - YES Value Bets (${yesBets.length} found):`);
  yesBets.slice(0, 3).forEach(b => {
    console.log(`   ${b.type}: ${b.question.substring(0, 40)}...`);
    console.log(`      Probability: ${b.probability.toFixed(1)}% | Win: $${b.potentialWin.toFixed(2)}`);
  });
  
  // Strategy 3: Arbitrage
  const arbBets = findArbitrageOpportunities(markets);
  console.log(`\n🎯 Strategy 3 - Arbitrage (${arbBets.length} found):`);
  arbBets.slice(0, 3).forEach(b => {
    console.log(`   ${b.type}: ${b.question.substring(0, 40)}...`);
    console.log(`      ${b.note}`);
  });
  
  // Prioritize: NO > ARBITRAGE > YES
  const allOpportunities = [
    ...noBets.map(b => ({...b, priority: 1})),
    ...arbBets.map(b => ({...b, priority: 2})),
    ...yesBets.map(b => ({...b, priority: 3}))
  ];
  
  // Sort by expected value
  allOpportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  
  if (allOpportunities.length > 0) {
    const best = allOpportunities[0];
    console.log(`\n🔥 BEST OPPORTUNITY:`);
    console.log(`   ${best.type}: ${best.question.substring(0, 50)}...`);
    console.log(`   Probability: ${best.probability.toFixed(1)}%`);
    console.log(`   Expected Value: $${best.expectedValue.toFixed(2)}`);
    console.log(`   Link: ${best.url}`);
    
    // Record the bet
    bets.push({
      ...best,
      amount: CONFIG.betSize,
      placedAt: new Date().toISOString(),
      status: 'PENDING'
    });
    
    dailyBetCount++;
    
    console.log(`\n💰 To place bet: Visit the link above and bet $${CONFIG.betSize} on ${best.type}`);
  } else {
    console.log(`\n⏳ No opportunities found. Waiting for next scan...`);
  }
  
  printStats();
}

function printStats() {
  console.log(`\n📈 STATS:`);
  console.log(`   Today's bets: ${dailyBetCount}/${CONFIG.maxBetsPerDay}`);
  console.log(`   Total opportunities found: ${bets.length}`);
  
  const byType = { NO: 0, YES: 0, ARBITRAGE: 0 };
  bets.forEach(b => byType[b.type] = (byType[b.type] || 0) + 1);
  
  console.log(`   By type: NO: ${byType.NO} | YES: ${byType.YES} | ARB: ${byType.ARBITRAGE}`);
}

function saveLogs() {
  const fs = require('fs');
  fs.writeFileSync('/data/workspace/polymarket-bot/logs.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    dailyBetCount,
    totalProfit,
    bets: bets.slice(-100)
  }, null, 2));
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         🎲 POLYMARKET ALPHA BOT v2.0                          ║
║         Three strategies: NO | ARBITRAGE | YES                ║
║         Based on the $3.7M framework                          ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  console.log(`⚙️ Configuration:`);
  console.log(`   NO Probability: ${CONFIG.minProbabilityNO}-${CONFIG.maxProbabilityNO}%`);
  console.log(`   YES Probability: ${CONFIG.minProbabilityYES}-${CONFIG.maxProbabilityYES}%`);
  console.log(`   Bet Size: $${CONFIG.betSize}`);
  console.log(`   Max Bets/Day: ${CONFIG.maxBetsPerDay}`);
  
  // Run immediately then every 5 minutes
  runStrategy();
  setInterval(runStrategy, 5 * 60 * 1000);
}

main().catch(console.error);
