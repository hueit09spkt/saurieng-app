const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const Database = require('better-sqlite3');
const app = express();
const port = process.env.PORT || 3000;

// Khởi tạo database
const db = new Database('./data/gardens.db');

// Tạo tables nếu chưa có
db.exec(`
    CREATE TABLE IF NOT EXISTS gardens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        rows INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        garden_id INTEGER NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        variety TEXT,
        status TEXT,
        notes TEXT,
        images TEXT,
        harvest_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (garden_id) REFERENCES gardens (id),
        UNIQUE(garden_id, row, col)
    );
`);

// Cấu hình Multer để lưu ảnh
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = 'uploads/';
        require('fs').mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Phục vụ file tĩnh từ thư mục public
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

// Hàm trợ giúp để đọc và ghi database
const readGardens = () => {
    const gardens = db.prepare('SELECT * FROM gardens ORDER BY created_at DESC').all();
    return gardens.map(garden => {
        const trees = db.prepare('SELECT * FROM trees WHERE garden_id = ?').all(garden.id);
        return {
            ...garden,
            trees: trees.map(tree => ({
                row: tree.row,
                col: tree.col,
                variety: tree.variety,
                status: tree.status,
                notes: tree.notes,
                images: tree.images ? JSON.parse(tree.images) : [],
                harvestInfo: tree.harvest_info ? JSON.parse(tree.harvest_info) : []
            }))
        };
    });
};

const writeGarden = (gardenData) => {
    const stmt = db.prepare('INSERT INTO gardens (name, rows, cols) VALUES (?, ?, ?)');
    const result = stmt.run(gardenData.name, gardenData.rows, gardenData.cols);
    return result.lastInsertRowid;
};

const updateTree = (gardenName, treeData) => {
    const garden = db.prepare('SELECT id FROM gardens WHERE name = ?').get(gardenName);
    if (!garden) return false;

    const images = JSON.stringify(treeData.images || []);
    const harvestInfo = JSON.stringify(treeData.harvestInfo || []);

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO trees 
        (garden_id, row, col, variety, status, notes, images, harvest_info, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    stmt.run(
        garden.id,
        treeData.row,
        treeData.col,
        treeData.variety,
        treeData.status,
        treeData.notes,
        images,
        harvestInfo
    );
    
    return true;
};

const deleteGarden = (gardenName) => {
    const garden = db.prepare('SELECT id FROM gardens WHERE name = ?').get(gardenName);
    if (!garden) return false;

    db.prepare('DELETE FROM trees WHERE garden_id = ?').run(garden.id);
    db.prepare('DELETE FROM gardens WHERE id = ?').run(garden.id);
    return true;
};

// Hàm wrapper để xử lý lỗi trong các route async
const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Lấy danh sách vườn
app.get('/api/gardens', asyncHandler(async (req, res) => {
    const gardens = readGardens();
    res.json(gardens);
}));

// Thêm vườn
app.post('/api/gardens', asyncHandler(async (req, res) => {
    const newGarden = req.body;
    if (!newGarden || !newGarden.name || !newGarden.rows || !newGarden.cols) {
        return res.status(400).json({ error: 'Dữ liệu vườn không hợp lệ.' });
    }

    try {
        const gardenId = writeGarden(newGarden);
        res.status(201).json({ ...newGarden, id: gardenId });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'Tên vườn đã tồn tại.' });
        }
        throw error;
    }
}));

// Xóa vườn
app.delete('/api/gardens/:name', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const success = deleteGarden(gardenName);

    if (!success) {
        return res.status(404).json({ error: 'Không tìm thấy vườn để xóa.' });
    }

    res.json({ success: true });
}));

// Cập nhật thông tin cây
app.post('/api/gardens/:name/trees', upload.array('images', 10), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const treeData = req.body;
    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    // Xử lý nhiều hình ảnh
    const uploadedImages = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    const existingImages = treeData.existingImages ? JSON.parse(treeData.existingImages) : [];
    const allImages = [...existingImages, ...uploadedImages];

    // Xử lý thông tin thu hoạch
    let harvestInfo = [];
    if (treeData.harvestInfo) {
        try {
            harvestInfo = JSON.parse(treeData.harvestInfo);
        } catch (e) {
            harvestInfo = [];
        }
    }

    const finalTreeData = {
        row,
        col,
        variety: treeData.variety,
        status: treeData.status,
        notes: treeData.notes,
        images: allImages,
        harvestInfo
    };

    const success = updateTree(gardenName, finalTreeData);
    if (!success) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    res.json({ success: true });
}));

// Gom nhóm cây theo tình trạng
app.get('/api/gardens/:name/grouped', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const garden = db.prepare('SELECT id FROM gardens WHERE name = ?').get(gardenName);

    if (!garden) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    const trees = db.prepare('SELECT status FROM trees WHERE garden_id = ?').all(garden.id);
    const groupedTrees = trees.reduce((acc, tree) => {
        const status = tree.status || 'Không xác định';
        if (!acc[status]) acc[status] = [];
        acc[status].push(tree);
        return acc;
    }, {});

    res.json(groupedTrees);
}));

// Tạo và tải file backup
app.get('/api/backup', (req, res, next) => {
    const backupFileName = 'backup.zip';
    const output = require('fs').createWriteStream(backupFileName);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        res.download(backupFileName, 'saurieng_backup.zip', (err) => {
            if (err) next(err);
            fs.unlink(backupFileName);
        });
    });

    archive.on('error', (err) => next(err));

    archive.file(dataFile, { name: 'gardens.json' });
    archive.directory('uploads/', 'uploads');
    archive.finalize();
});

// Middleware xử lý lỗi tập trung
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Đã có lỗi xảy ra ở server!');
});

// Khởi tạo các thư mục cần thiết và khởi động server
const initialize = async () => {
    try {
        await fs.mkdir('./data', { recursive: true });
        await fs.mkdir('./uploads', { recursive: true });
        
        // Kiểm tra xem có dữ liệu mẫu chưa
        const gardens = readGardens();
        if (gardens.length === 0) {
            // Tạo vườn mẫu
            const gardenId = writeGarden({
                name: "Vườn Mẫu",
                rows: 5,
                cols: 5
            });
            
            // Thêm cây mẫu
            const sampleTrees = [
                { row: 1, col: 1, status: "Khỏe mạnh", variety: "Ri6" },
                { row: 2, col: 2, status: "Sâu bệnh", variety: "Ri6" },
                { row: 3, col: 3, status: "Mới trồng", variety: "Chín Thơm" }
            ];
            
            sampleTrees.forEach(tree => {
                updateTree("Vườn Mẫu", tree);
            });
        }

        app.listen(port, () => {
            console.log(`Server chạy tại http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Không thể khởi động server:', error);
        process.exit(1);
    }
};
initialize();