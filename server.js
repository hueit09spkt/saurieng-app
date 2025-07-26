const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = process.env.PORT || 3000;

// Khởi tạo database
const db = new sqlite3.Database('./data/gardens.db');

// Tạo tables nếu chưa có
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS gardens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            rows INTEGER NOT NULL,
            cols INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
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
        )
    `);
});

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Hàm trợ giúp để đọc và ghi database
const readGardens = () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM gardens ORDER BY created_at DESC', [], (err, gardens) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (gardens.length === 0) {
                resolve([]);
                return;
            }
            
            const gardensWithTrees = [];
            let processed = 0;
            
            gardens.forEach(garden => {
                db.all('SELECT * FROM trees WHERE garden_id = ?', [garden.id], (err, trees) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    gardensWithTrees.push({
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
                    });
                    
                    processed++;
                    if (processed === gardens.length) {
                        resolve(gardensWithTrees);
                    }
                });
            });
        });
    });
};

const writeGarden = (gardenData) => {
    return new Promise((resolve, reject) => {
        db.run('INSERT INTO gardens (name, rows, cols) VALUES (?, ?, ?)', 
            [gardenData.name, gardenData.rows, gardenData.cols], 
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
    });
};

const updateTree = (gardenName, treeData) => {
    return new Promise((resolve, reject) => {
        console.log('updateTree được gọi với:', { gardenName, treeData });
        
        db.get('SELECT id FROM gardens WHERE name = ?', [gardenName], (err, garden) => {
            if (err) {
                console.error('Lỗi khi tìm garden:', err);
                reject(err);
                return;
            }
            
            if (!garden) {
                console.log('Không tìm thấy garden:', gardenName);
                resolve(false);
                return;
            }
            
            const images = JSON.stringify(treeData.images || []);
            const harvestInfo = JSON.stringify(treeData.harvestInfo || []);
            
            console.log('Sẽ lưu vào database:', {
                gardenId: garden.id,
                row: treeData.row,
                col: treeData.col,
                variety: treeData.variety,
                status: treeData.status,
                notes: treeData.notes,
                imagesCount: treeData.images ? treeData.images.length : 0,
                harvestInfoCount: treeData.harvestInfo ? treeData.harvestInfo.length : 0
            });
            
            db.run(`
                INSERT OR REPLACE INTO trees 
                (garden_id, row, col, variety, status, notes, images, harvest_info, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                garden.id,
                treeData.row,
                treeData.col,
                treeData.variety,
                treeData.status,
                treeData.notes,
                images,
                harvestInfo
            ], function(err) {
                if (err) {
                    console.error('Lỗi khi lưu tree:', err);
                    reject(err);
                } else {
                    console.log('Lưu tree thành công, lastID:', this.lastID);
                    resolve(true);
                }
            });
        });
    });
};

const deleteGarden = (gardenName) => {
    return new Promise((resolve, reject) => {
        db.get('SELECT id FROM gardens WHERE name = ?', [gardenName], (err, garden) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!garden) {
                resolve(false);
                return;
            }
            
            db.run('DELETE FROM trees WHERE garden_id = ?', [garden.id], (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                db.run('DELETE FROM gardens WHERE id = ?', [garden.id], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            });
        });
    });
};

// Hàm wrapper để xử lý lỗi trong các route async
const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Lấy danh sách vườn
app.get('/api/gardens', asyncHandler(async (req, res) => {
    const gardens = await readGardens();
    res.json(gardens);
}));

// Thêm vườn
app.post('/api/gardens', asyncHandler(async (req, res) => {
    const newGarden = req.body;
    if (!newGarden || !newGarden.name || !newGarden.rows || !newGarden.cols) {
        return res.status(400).json({ error: 'Dữ liệu vườn không hợp lệ.' });
    }

    try {
        const gardenId = await writeGarden(newGarden);
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
    const success = await deleteGarden(gardenName);

    if (!success) {
        return res.status(404).json({ error: 'Không tìm thấy vườn để xóa.' });
    }

    res.json({ success: true });
}));

// Cập nhật thông tin cây (JSON data)
app.post('/api/gardens/:name/trees/json', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const treeData = req.body;
    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận dữ liệu JSON từ client:', {
        gardenName,
        row,
        col,
        variety: treeData.variety,
        status: treeData.status,
        notes: treeData.notes,
        existingImagesLength: treeData.existingImages ? treeData.existingImages.length : 0,
        harvestInfoLength: treeData.harvestInfo ? treeData.harvestInfo.length : 0
    });

    const finalTreeData = {
        row,
        col,
        variety: treeData.variety || '',
        status: treeData.status || '',
        notes: treeData.notes || '',
        images: [], // Sẽ được cập nhật sau khi upload images
        harvestInfo: treeData.harvestInfo || []
    };

    console.log('Dữ liệu cuối cùng:', finalTreeData);

    try {
        const success = await updateTree(gardenName, finalTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Lỗi khi lưu cây:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu thông tin cây.' });
    }
}));

// Cập nhật hình ảnh cho cây
app.post('/api/gardens/:name/trees/images', upload.array('images', 10), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const row = parseInt(req.body.row, 10);
    const col = parseInt(req.body.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận hình ảnh từ client:', {
        gardenName,
        row,
        col,
        filesCount: req.files ? req.files.length : 0
    });

    // Lấy thông tin cây hiện tại
    const gardens = await readGardens();
    const garden = gardens.find(g => g.name === gardenName);
    if (!garden) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    const tree = garden.trees.find(t => t.row === row && t.col === col);
    
    // Thêm hình ảnh mới
    const uploadedImages = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    
    let updatedTreeData;
    if (tree) {
        // Cập nhật cây hiện có
        updatedTreeData = {
            ...tree,
            images: [...(tree.images || []), ...uploadedImages]
        };
    } else {
        // Tạo cây mới chỉ với hình ảnh
        updatedTreeData = {
            row,
            col,
            variety: '',
            status: 'Khỏe mạnh',
            notes: '',
            images: uploadedImages,
            harvestInfo: []
        };
    }

    console.log('Cập nhật tree với images:', {
        existingImagesCount: tree ? (tree.images || []).length : 0,
        newImagesCount: uploadedImages.length,
        totalImagesCount: updatedTreeData.images.length
    });

    try {
        const success = await updateTree(gardenName, updatedTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true, uploadedImages });
    } catch (error) {
        console.error('Lỗi khi lưu hình ảnh:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu hình ảnh.' });
    }
}));

// Cập nhật thông tin cây (legacy - giữ lại để tương thích)
app.post('/api/gardens/:name/trees', upload.array('images', 10), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const treeData = req.body;
    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận dữ liệu từ client:', {
        gardenName,
        row,
        col,
        variety: treeData.variety,
        status: treeData.status,
        notes: treeData.notes,
        existingImagesLength: treeData.existingImages ? treeData.existingImages.length : 0,
        harvestInfoLength: treeData.harvestInfo ? treeData.harvestInfo.length : 0,
        filesCount: req.files ? req.files.length : 0
    });

    // Xử lý nhiều hình ảnh
    const uploadedImages = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    
    // Xử lý existingImages an toàn hơn
    let existingImages = [];
    if (treeData.existingImages && treeData.existingImages !== 'undefined' && treeData.existingImages !== '[]') {
        try {
            existingImages = JSON.parse(treeData.existingImages);
        } catch (e) {
            console.log('Lỗi parse existingImages:', e);
            existingImages = [];
        }
    }
    
    const allImages = [...existingImages, ...uploadedImages];

    // Xử lý thông tin thu hoạch an toàn hơn
    let harvestInfo = [];
    if (treeData.harvestInfo && treeData.harvestInfo !== 'undefined' && treeData.harvestInfo !== '[]') {
        try {
            harvestInfo = JSON.parse(treeData.harvestInfo);
        } catch (e) {
            console.log('Lỗi parse harvestInfo:', e);
            harvestInfo = [];
        }
    }

    const finalTreeData = {
        row,
        col,
        variety: treeData.variety || '',
        status: treeData.status || '',
        notes: treeData.notes || '',
        images: allImages,
        harvestInfo
    };

    console.log('Dữ liệu cuối cùng:', finalTreeData);

    try {
        const success = await updateTree(gardenName, finalTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Lỗi khi lưu cây:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu thông tin cây.' });
    }
}));

// Debug: Kiểm tra dữ liệu database
app.get('/api/debug/gardens/:name', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM gardens WHERE name = ?', [gardenName], (err, garden) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!garden) {
                res.json({ error: 'Không tìm thấy vườn' });
                resolve();
                return;
            }
            
            db.all('SELECT * FROM trees WHERE garden_id = ?', [garden.id], (err, trees) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                res.json({
                    garden,
                    trees: trees.map(tree => ({
                        ...tree,
                        images: tree.images ? JSON.parse(tree.images) : [],
                        harvest_info: tree.harvest_info ? JSON.parse(tree.harvest_info) : []
                    }))
                });
                resolve();
            });
        });
    });
}));

// Gom nhóm cây theo tình trạng
app.get('/api/gardens/:name/grouped', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    
    return new Promise((resolve, reject) => {
        db.get('SELECT id FROM gardens WHERE name = ?', [gardenName], (err, garden) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!garden) {
                res.status(404).json({ error: 'Không tìm thấy vườn.' });
                resolve();
                return;
            }
            
            db.all('SELECT status FROM trees WHERE garden_id = ?', [garden.id], (err, trees) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const groupedTrees = trees.reduce((acc, tree) => {
                    const status = tree.status || 'Không xác định';
                    if (!acc[status]) acc[status] = [];
                    acc[status].push(tree);
                    return acc;
                }, {});
                
                res.json(groupedTrees);
                resolve();
            });
        });
    });
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
        const gardens = await readGardens();
        if (gardens.length === 0) {
            // Tạo vườn mẫu
            const gardenId = await writeGarden({
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
            
            for (const tree of sampleTrees) {
                await updateTree("Vườn Mẫu", tree);
            }
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