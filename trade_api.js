const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const _ = require('lodash');

// Khởi tạo Express
const app = express();
const port = process.env.PORT || 10000;

// Cho phép nhận JSON từ body
app.use(express.json());

// Kết nối MongoDB
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Schema và Model cho MongoDB
const filterSchema = new mongoose.Schema({
    name: { type: String, required: true },
    query: { type: Object, required: true },
    maxPrice: {
        divine: { type: Number, required: true },
        exalted: { type: Number, required: true }
    }
});

const Filter = mongoose.model('Filter', filterSchema);

// Thông tin bot Telegram
const botToken = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;

const bot = new TelegramBot(botToken, { polling: false });

// Headers chung cho cả hai API
const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9,vi;q=0.8,fr-FR;q=0.7,fr;q=0.6',
    'content-type': 'application/json',
    'origin': 'https://www.pathofexile.com',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest'
};

// Hàm gửi thông báo qua Telegram
async function sendNotification(item) {
    const message = `Found cheap item! Name: ${item.name}, Price: ${item.price.amount} ${item.price.currency}\nLink: ${item.link}`;
    try {
        await bot.sendMessage(chatId, message);
        console.log('Sent notification:', message);
    } catch (error) {
        console.error('Error sending notification:', error);
        throw error;
    }
}

// Hàm gọi API 1: Tìm kiếm món đồ
async function searchItems(query) {
    const url = 'https://www.pathofexile.com/api/trade2/search/poe2/Dawn%20of%20the%20Hunt';
    const data = {
        query: query,
        sort: { price: 'asc' }
    };

    try {
        const response = await axios.post(url, data, { headers });
        return response.data; // Trả về query ID và danh sách ID món đồ
    } catch (error) {
        console.error('Error searching items:', error);
        throw error;
    }
}

// Hàm gọi API 2: Lấy chi tiết món đồ
async function fetchItemDetails(queryId, itemIds) {
    const url = `https://www.pathofexile.com/api/trade2/fetch/${itemIds}?query=${queryId}&realm=poe2`;
    try {
        const response = await axios.get(url, { headers });
        return response.data.result; // Trả về chi tiết các món đồ
    } catch (error) {
        console.error('Error fetching item details:', error);
        throw error;
    }
}

// Hàm chính: Quét và lọc món đồ
async function checkTradePage() {
    try {
        // Lấy tất cả query filter từ MongoDB
        const filters = await Filter.find().lean();
        if (filters.length === 0) {
            return [];
        }

        const allCheapItems = [];

        // Lặp qua từng query filter
        for (const filter of filters) {
            // Bước 1: Gọi API 1 để lấy danh sách ID món đồ
            const searchResult = await searchItems(filter.query);
            // console.log('searchResult', JSON.stringify(searchResult));
            const queryId = searchResult.id; // Ví dụ: EDQkqeVT5
            const itemIds = searchResult.result.slice(0, 10); // Lấy 10 ID đầu tiên
            const itemIdsString = itemIds.join(','); // Chuỗi ID để gọi API 2

            if (!itemIdsString) {
                continue;
            }

            // Bước 2: Gọi API 2 để lấy chi tiết món đồ
            const items = await fetchItemDetails(queryId, itemIdsString);

            // Bước 3: Lọc món đồ giá rẻ và tạo link
            const cheapItems = [];

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                // console.log('item', JSON.stringify(item));
                const itemId = itemIds[i]; // ID của món đồ tương ứng
                const listing = item.listing;
                const price = listing.price;

                if (price) {
                    const amount = price.amount;
                    const currency = price.currency;

                    // Kiểm tra giá: dưới maxPrice.divine hoặc maxPrice.exalted
                    const isCheap = (currency === 'divine' && amount < filter.maxPrice.divine) || 
                                   (currency === 'exalted' && amount < filter.maxPrice.exalted);

                    if (isCheap) {
                        // Tạo link của món đồ
                        const link = `https://www.pathofexile.com/trade2/search/poe2/Dawn%20of%20the%20Hunt/${queryId}`;
                        const cheapItem = {
                            name: _.get(item, 'item.name') || _.get(item, 'item.typeLine'),
                            price: price,
                            link: link,
                            whisper: _.get(item, 'listing.whisper') || '',
                        };
                        cheapItems.push(cheapItem);
                    }
                }
            }

            // Bước 4: Gửi thông báo cho các món đồ rẻ
            for (const item of cheapItems) {
                await sendNotification(item);
            }

            allCheapItems.push(...cheapItems);
        }

        return allCheapItems;
    } catch (error) {
        console.error('Error in checkTradePage:', error);
        throw error;
    }
}

// API để xem tất cả filter
app.get('/filters', async (req, res) => {
    try {
        const filters = await Filter.find().lean();
        res.status(200).json({
            message: 'Retrieved filters successfully',
            filters: filters
        });
    } catch (error) {
        console.error('Error retrieving filters:', error);
        res.status(500).json({
            message: 'Error retrieving filters',
            error: error.message
        });
    }
});

// API để thêm query filter
app.post('/add-filter', async (req, res) => {
    try {
        const { name, query, maxPrice } = req.body;

        // Kiểm tra dữ liệu đầu vào
        if (!name || !query || !maxPrice || !maxPrice.divine || !maxPrice.exalted) {
            return res.status(400).json({ message: 'Missing required fields: name, query, maxPrice.divine, maxPrice.exalted' });
        }

        // Lưu filter vào MongoDB
        const newFilter = new Filter({
            name,
            query,
            maxPrice
        });
        await newFilter.save();

        res.status(201).json({
            message: 'Filter added successfully',
            filter: newFilter
        });
    } catch (error) {
        console.error('Error adding filter:', error);
        res.status(500).json({
            message: 'Error adding filter',
            error: error.message
        });
    }
});

// API để xóa query filter
app.delete('/delete-filter/:id', async (req, res) => {
    try {
        const filterId = req.params.id;

        // Kiểm tra ID hợp lệ
        if (!filterId) {
            return res.status(400).json({ message: 'Invalid filter ID' });
        }

        // Xóa filter
        const result = await Filter.findByIdAndDelete(filterId).lean();
        if (!result) {
            return res.status(404).json({ message: 'Filter not found' });
        }

        res.status(200).json({
            message: 'Filter deleted successfully',
            filter: result
        });
    } catch (error) {
        console.error('Error deleting filter:', error);
        res.status(500).json({
            message: 'Error deleting filter',
            error: error.message
        });
    }
});

// API endpoint để kiểm tra trang trade
app.get('/check-trade', async (req, res) => {
    try {
        console.log('Received request to check trade page at', new Date().toISOString());
        const cheapItems = await checkTradePage();
        res.status(200).json({
            message: 'Checked trade page successfully',
            items: cheapItems
        });
    } catch (error) {
        res.status(500).json({
            message: 'Error checking trade page',
            error: error.message
        });
    }
});

// Chạy server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});