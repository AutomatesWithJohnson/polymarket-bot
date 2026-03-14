const axios = require('axios');

// ============== CONFIG ==============
const CONFIG = {
  // PolyMarket GraphQL endpoint
  graphqlEndpoint: 'https://clob.polymarket.com/graphql',
  // Minimum probability to bet on (85-95%)
  minProbability: 85,
  maxProbability: 95,
  // Bet size (in dollars)
  betSize: 1, // Start small!
  // Max bets per day
  maxBetsPerDay: 5,
  // Markets to watch (leave empty for all)
  watchCategories: ['politics', 'crypto', 'sports', 'science'],
  // Only bet on "Yes" when probability is high
  betOn: 'YES'
};

// ============== STATE ==============
let bets = [];
let dailyBetCount = 0;
let dailyWinnings = 0;

// ============== POLYMARKET API ==============
async function getMarkets() {
  const query = `
    query GetMarkets {
      markets(
        limit: 50
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

function parseProbability(priceStr) {
  // Price is usually like "0.85" for 85%
  const price = parseFloat(priceStr);
  return price * 100;
}

function findValueBets(markets) {
  const valueBets = [];
  
  for (const market of markets) {
    if (!market.outcomePrices || !market.outcomeNames) continue;
    
    // Skip markets that have ended
    if (new Date(market.endDate) < new Date()) continue;
    
    // Parse probabilities
    const outcomes = market.outcomeNames.map((name, i) => ({
      name,
      price: parseProbability(market.outcomePrices[i])
    }));
    
    // Find "Yes" outcome
    const yesOutcome = outcomes.find(o => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'positive');
    const noOutcome = outcomes.find(o => o.name.toLowerCase() === 'no' || o.name.toLowerCase() === 'negative');
    
    if (!yesOutcome) continue;
    
    const probability = yesOutcome.price;
    
    // Check if it's a value bet (between min and max probability)
    if (probability >= CONFIG.minProbability && probability <= CONFIG.maxProbability) {
      valueBets.push({
        id: market.id,
        question: market.question,
        probability,
        potentialWin: CONFIG.betSize * ((100 / probability) - 1),
        endDate: market.endDate,
        categories: market.categories
      });
    }
  }
  
  return valueBets;
}

// ============== BETTING LOGIC ==============
async function placeBet(market) {
  console.log(`\n🎯 PLACING BET:`);
  console.log(`   Question: ${market.question}`);
  console.log(`   Probability: ${market.probability.toFixed(1)}%`);
  console.log(`   Potential Win: $${market.potentialWin.toFixed(2)}`);
  
  // NOTE: PolyMarket doesn't have a public API for placing bets
  // This would require their trading API or using their UI programmatically
  // For now, we'll log the bet and create a "betting slip"
  
  const bet = {
    id: market.id,
    question: market.question,
    probability: market.probability,
    amount: CONFIG.betSize,
    potentialWin: market.potentialWin,
    placedAt: new Date().toISOString(),
    status: 'PENDING'
  };
  
  bets.push(bet);
  dailyBetCount++;
  
  console.log(`\n⚠️ NOTE: PolyMarket requires manual betting or their API access.`);
  console.log(`📋 Bet recorded - visit polymarket.com to place the bet manually.`);
  console.log(`🔗 Market: https://polymarket.com/market/${market.id}`);
  
  saveLogs();
  
  return bet;
}

// ============== STRATEGY ==============
async function runStrategy() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎲 POLYMARKET VALUE BOT - ${new Date().toLocaleString()}`);
  console.log('='.repeat(60));
  
  if (dailyBetCount >= CONFIG.maxBetsPerDay) {
    console.log(`⚠️ Daily bet limit reached (${CONFIG.maxBetsPerDay})`);
    return;
  }
  
  console.log(`\n🔍 Scanning markets for value bets (${CONFIG.minProbability}-${CONFIG.maxProbability}%)...`);
  
  const markets = await getMarkets();
  console.log(`📊 Found ${markets.length} open markets`);
  
  const valueBets = findValueBets(markets);
  console.log(`💎 Found ${valueBets.length} value bet opportunities`);
  
  if (valueBets.length > 0) {
    // Sort by highest probability (safest bets)
    valueBets.sort((a, b) => b.probability - a.probability);
    
    console.log(`\n📋 TOP VALUE BETS:`);
    valueBets.slice(0, 5).forEach((bet, i) => {
      console.log(`   ${i + 1}. ${bet.question.substring(0, 50)}...`);
      console.log(`      ${bet.probability.toFixed(1)}% - Win $${bet.potentialWin.toFixed(2)}`);
    });
    
    // Place bet on highest probability
    if (valueBets.length > 0) {
      await placeBet(valueBets[0]);
    }
  } else {
    console.log(`\n⏳ No value bets found. Waiting for better opportunities...`);
  }
  
  printStats();
}

// ============== STATS ==============
function printStats() {
  console.log(`\n📈 STATS:`);
  console.log(`   Today's bets: ${dailyBetCount}/${CONFIG.maxBetsPerDay}`);
  console.log(`   Total bets: ${bets.length}`);
  
  const pending = bets.filter(b => b.status === 'PENDING').length;
  const won = bets.filter(b => b.status === 'WON').length;
  const lost = bets.filter(b => b.status === 'LOST').length;
  
  console.log(`   Pending: ${pending} | Won: ${won} | Lost: ${lost}`);
}

function saveLogs() {
  const fs = require('fs');
  const log = {
    timestamp: new Date().toISOString(),
    dailyBetCount,
    bets: bets.slice(-50)
  };
  fs.writeFileSync('/data/workspace/polymarket-bot/logs.json', JSON.stringify(log, null, 2));
}

// ============== MAIN ==============
async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         🎲 POLYMARKET VALUE BOT                       ║
║         Betting on high probability outcomes          ║
╚═══════════════════════════════════════════════════════╝
  `);
  
  console.log(`⚙️ Config:`);
  console.log(`   Probability range: ${CONFIG.minProbability}-${CONFIG.maxProbability}%`);
  console.log(`   Bet size: $${CONFIG.betSize}`);
  console.log(`   Max bets/day: ${CONFIG.maxBetsPerDay}`);
  
  // Run immediately then every hour
  runStrategy();
  setInterval(runStrategy, 60 * 60 * 1000);
}

main().catch(console.error);
