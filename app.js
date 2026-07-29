        const firebaseConfig = {
            apiKey: "AIzaSyBqZqKDGk0i6vT33XsKeyFRWDHQvc48MQ0",
            authDomain: "zenwriter-67a82.firebaseapp.com",
            databaseURL: "https://zenwriter-67a82-default-rtdb.firebaseio.com",
            projectId: "zenwriter-67a82",
            storageBucket: "zenwriter-67a82.firebasestorage.app",
            messagingSenderId: "1091280994327",
            appId: "1:1091280994327:web:46d41ca0e3d77dcdb1dc52"
        };

        firebase.initializeApp(firebaseConfig);
        const db = firebase.database();

        // --- Configuración de Base de Datos Local (IndexedDB) ---
        const localDB = new Dexie("ZenWriterDB");
        localDB.version(1).stores({
            notes: 'id, title, content, date, clase, timestamp',
            appState: 'id, data'
        });

        let notes = [];
        let deletedNotesLog = [];
        let classes = ['tareas', 'comidas', 'links'];
        let recentColors = ['#4a9eff', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6', '#1abc9c', '#e67e22', '#3498db', '#95a5a6', '#34495e'];
        let masterClasses = [];

        let currentClass = localStorage.getItem('zen_current_class') || 'tareas';
        let copyWithTitle = localStorage.getItem('zen_copy_mode') !== 'false';
        let showPreview = localStorage.getItem('zen_show_preview') !== 'false';
        let showDate = localStorage.getItem('zen_show_date') !== 'false';
        let showClassTag = localStorage.getItem('zen_show_class') !== 'false';
        let showCharCount = localStorage.getItem('zen_show_charcount') === 'true';
        let noteSize = localStorage.getItem('zen_note_size') || 'medium';

        let currentMasterClass = null;

        let isOnline = false;
        let currentNoteIndex = null;
        let currentColorNoteId = null;
        let pickr = null;
        let pickrInitialized = false;

        // Datos de sincronización
        let syncData = {
            deletedNotes: [],
            classChanges: null,
            colorChanges: [],
            contentConflicts: [],
            classChoice: null,
            colorChoices: {},
            contentChoices: {}
        };

        let lobbyScrollPos = 0;
        let autoScrollInterval = null;
        let scrollSpeed = 0;

        let draggedClassItem = null;
        let draggedNoteId = null;
        let placeholder = document.createElement('div');
        placeholder.className = 'note-placeholder';

        function showLoading(text = 'Procesando...') {
            const overlay = document.getElementById('loading-overlay');
            const textEl = document.getElementById('loading-text');
            textEl.innerText = text;
            overlay.style.display = 'flex';
        }

        function hideLoading() {
            const overlay = document.getElementById('loading-overlay');
            overlay.style.display = 'none';
        }

        function getContrastColor(hexcolor) {
            if (!hexcolor || hexcolor === '#242424') return '#d1d1d1';
            let r, g, b;
            if (hexcolor.startsWith('#')) {
                r = parseInt(hexcolor.slice(1, 3), 16);
                g = parseInt(hexcolor.slice(3, 5), 16);
                b = parseInt(hexcolor.slice(5, 7), 16);
            } else {
                return '#d1d1d1';
            }
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return luminance > 0.5 ? '#000000' : '#ffffff';
        }

        function truncateText(text, maxLength = 100) {
            if (!text) return '';
            if (text.length <= maxLength) return text;
            return text.substring(0, maxLength) + '...';
        }

        function saveRecentColor(color) {
            if (!color) return;
            const index = recentColors.indexOf(color);
            if (index !== -1) {
                recentColors.splice(index, 1);
            }
            recentColors.unshift(color);
            if (recentColors.length > 15) recentColors.pop();
            localStorage.setItem('zen_recent_colors', JSON.stringify(recentColors));
        }

        function addToDeletedLog(noteId) {
            if (!deletedNotesLog.includes(noteId)) {
                deletedNotesLog.unshift(noteId);
                if (deletedNotesLog.length > 30) deletedNotesLog.pop();
                localStorage.setItem('zen_deleted_log', JSON.stringify(deletedNotesLog));

                if (isOnline) {
                    db.ref('metadata/deleted_notes').set({
                        list: deletedNotesLog,
                        timestamp: Date.now()
                    });
                }
            }
        }

        function destroyPickr() {
            if (pickr) {
                try {
                    pickr.destroy();
                } catch (e) { }
                pickr = null;
            }
            pickrInitialized = false;
        }

        function closeColorModal() {
            const modal = document.getElementById('modal-color');
            if (modal) modal.style.display = 'none';
            currentColorNoteId = null;
            destroyPickr();
            const container = document.getElementById('pickr-container');
            if (container) container.innerHTML = '';
        }

        function renderRecentColors() {
            const recentColorsDiv = document.getElementById('recent-colors');
            if (!recentColorsDiv) return;
            recentColorsDiv.innerHTML = '';
            recentColors.forEach(color => {
                const colorDiv = document.createElement('div');
                colorDiv.className = 'recent-color';
                colorDiv.style.backgroundColor = color;
                colorDiv.title = color;
                colorDiv.onclick = (e) => {
                    e.stopPropagation();
                    setNoteColorAndClose(color);
                };
                recentColorsDiv.appendChild(colorDiv);
            });
        }

        function openColorModal(noteId) {
            destroyPickr();
            currentColorNoteId = noteId;
            const note = notes.find(n => n.id === noteId);
            if (!note) return;

            const currentColor = note.color || '#242424';
            const titleEl = document.getElementById('color-note-title');
            const previewEl = document.getElementById('color-preview');
            if (titleEl) titleEl.innerText = `${note.title}`;
            if (previewEl) {
                previewEl.style.backgroundColor = currentColor;
                previewEl.style.color = getContrastColor(currentColor);
                previewEl.innerText = note.title.substring(0, 20);
            }

            renderRecentColors();

            const container = document.getElementById('pickr-container');
            if (container) {
                container.innerHTML = '';
                const pickrWrapper = document.createElement('div');
                pickrWrapper.id = 'pickr-inner-wrapper';
                container.appendChild(pickrWrapper);

                setTimeout(() => {
                    try {
                        if (!document.getElementById('pickr-inner-wrapper')) return;
                        pickr = Pickr.create({
                            el: '#pickr-inner-wrapper',
                            theme: 'monolith',
                            default: currentColor,
                            container: container,
                            inline: true,
                            showAlways: true,
                            components: {
                                preview: true,
                                opacity: false,
                                hue: true,
                                interaction: { hex: true, input: true, save: true }
                            }
                        });
                        pickrInitialized = true;
                        pickr.on('change', (color) => {
                            if (color) {
                                const newColor = color.toHEXA().toString();
                                applyColorToNote(newColor);
                                if (previewEl) {
                                    previewEl.style.backgroundColor = newColor;
                                    previewEl.style.color = getContrastColor(newColor);
                                }
                            }
                        });
                        pickr.on('save', (color) => {
                            if (color) {
                                const newColor = color.toHEXA().toString();
                                saveRecentColor(newColor);
                                renderRecentColors();
                            }
                        });
                    } catch (e) {
                        console.error('Error creating Pickr:', e);
                    }
                }, 100);
            }
            const modal = document.getElementById('modal-color');
            if (modal) modal.style.display = 'block';
        }

        function applyColorToNote(color) {
            if (currentColorNoteId) {
                const noteIndex = notes.findIndex(n => n.id === currentColorNoteId);
                if (noteIndex !== -1) {
                    notes[noteIndex].color = color;
                    notes[noteIndex].timestamp = Date.now(); // Actualizar timestamp
                    saveToLocal();
                    renderNotes();
                    if (isOnline && notes[noteIndex].synced) {
                        db.ref('notes/' + currentColorNoteId).update({ 
                            color: color,
                            timestamp: notes[noteIndex].timestamp 
                        });
                    }
                }
            }
        }

        function setNoteColorAndClose(color) {
            applyColorToNote(color);
            saveRecentColor(color);
            closeColorModal();
        }

        function resetNoteColorAndClose() {
            if (currentColorNoteId) {
                const noteIndex = notes.findIndex(n => n.id === currentColorNoteId);
                if (noteIndex !== -1) {
                    delete notes[noteIndex].color;
                    notes[noteIndex].timestamp = Date.now(); // Actualizar timestamp al quitar color
                    saveToLocal();
                    renderNotes();
                    if (isOnline && notes[noteIndex].synced) {
                        db.ref('notes/' + currentColorNoteId).update({ 
                            color: null,
                            timestamp: notes[noteIndex].timestamp 
                        });
                    }
                }
            }
            closeColorModal();
        }

        function togglePreviewMode() {
            showPreview = !showPreview;
            localStorage.setItem('zen_show_preview', showPreview);
            const btn = document.getElementById('btn-preview-mode');
            if (btn) btn.innerText = showPreview ? '📄 +contenido' : '📄 -contenido';
            renderNotes();
        }

        function toggleDateMode() {
            showDate = !showDate;
            localStorage.setItem('zen_show_date', showDate);
            const btn = document.getElementById('btn-date-mode');
            if (btn) btn.innerText = showDate ? '📅 +fecha' : '📅 -fecha';
            renderNotes();
        }

        function toggleClassMode() {
            showClassTag = !showClassTag;
            localStorage.setItem('zen_show_class', showClassTag);
            applySettings();
            renderNotes();
        }

        function toggleCharCountMode() {
            showCharCount = !showCharCount;
            localStorage.setItem('zen_show_charcount', showCharCount);
            const btn = document.getElementById('btn-charcount-mode');
            if (btn) btn.innerText = showCharCount ? '📊 -caracteres' : '📊 +caracteres';
            renderNotes();
        }

        // Auto-scroll
        function startAutoScroll(e) {
            const viewportHeight = window.innerHeight;
            const mouseY = e.clientY;
            const edgeThreshold = 120;
            if (mouseY < edgeThreshold) {
                const factor = 1 - (mouseY / edgeThreshold);
                scrollSpeed = -12 * Math.min(1, factor);
            } else if (mouseY > viewportHeight - edgeThreshold) {
                const factor = (mouseY - (viewportHeight - edgeThreshold)) / edgeThreshold;
                scrollSpeed = 12 * Math.min(1, factor);
            } else {
                scrollSpeed = 0;
            }
            if (autoScrollInterval) clearInterval(autoScrollInterval);
            if (Math.abs(scrollSpeed) > 0.5) {
                autoScrollInterval = setInterval(() => window.scrollBy(0, scrollSpeed), 16);
            }
        }

        function stopAutoScroll() {
            if (autoScrollInterval) clearInterval(autoScrollInterval);
            scrollSpeed = 0;
        }

        function noteDragStart(e, noteId) {
            draggedNoteId = noteId;
            const card = e.target.closest('.note-card');
            if (card) {
                card.classList.add('dragging');
                placeholder.style.height = card.offsetHeight + 'px';
                setTimeout(() => { if (card) card.style.display = 'none'; }, 0);
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', noteId);

            const container = document.getElementById('notes-list');
            container.addEventListener('dragover', onNoteListDragOver);
            container.addEventListener('drop', noteDrop);
            document.addEventListener('dragend', onDragEndGlobal);
        }

        function onNoteListDragOver(e) {
            e.preventDefault();
            startAutoScroll(e);

            const container = document.getElementById('notes-list');
            const draggingCard = container.querySelector('.dragging');
            const siblings = [...container.querySelectorAll('.note-card:not(.dragging)')];

            // Encontrar la nota que sigue a la posición del ratón
            const nextSibling = siblings.find(sibling => {
                const rect = sibling.getBoundingClientRect();
                const center = rect.top + rect.height / 2;
                return e.clientY < center;
            });

            if (nextSibling) {
                container.insertBefore(placeholder, nextSibling);
            } else {
                container.appendChild(placeholder);
            }
        }

        function onDragEndGlobal() {
            stopAutoScroll();
            const container = document.getElementById('notes-list');
            container.removeEventListener('dragover', onNoteListDragOver);
            container.removeEventListener('drop', noteDrop);

            if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
            document.querySelectorAll('.note-card').forEach(card => {
                card.classList.remove('dragging');
                card.style.display = 'block';
            });
            document.removeEventListener('dragend', onDragEndGlobal);
        }

        function noteDrop(e) {
            e.preventDefault();
            stopAutoScroll();

            if (draggedNoteId && placeholder.parentNode) {
                let nextNoteId = null;
                let sibling = placeholder.nextElementSibling;
                while (sibling) {
                    if (sibling.classList.contains('note-card') && !sibling.classList.contains('dragging')) {
                        nextNoteId = sibling.getAttribute('data-note-id');
                        break;
                    }
                    sibling = sibling.nextElementSibling;
                }

                const draggedIndex = notes.findIndex(n => n.id === draggedNoteId);
                if (draggedIndex !== -1) {
                    const [draggedNote] = notes.splice(draggedIndex, 1);

                    if (nextNoteId) {
                        const targetIndex = notes.findIndex(n => n.id === nextNoteId);
                        notes.splice(targetIndex, 0, draggedNote);
                    } else {
                        const classNotes = notes.filter(n => n.clase === currentClass);
                        if (classNotes.length > 0) {
                            const lastOfClass = classNotes[classNotes.length - 1];
                            const lastIndex = notes.findIndex(n => n.id === lastOfClass.id);
                            notes.splice(lastIndex + 1, 0, draggedNote);
                        } else {
                            notes.push(draggedNote);
                        }
                    }
                    saveToLocal();
                    renderNotes();
                    if (isOnline) uploadNotesOrderToCloud();
                }
            }

            if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
            draggedNoteId = null;
        }

        async function uploadNotesOrderToCloud() {
            if (!isOnline) return;
            const timestamp = Date.now();
            const orderData = {
                _lastChanged: timestamp
            };
            notes.forEach((note, index) => { 
                orderData[note.id] = { order: index }; 
            });
            await db.ref('metadata/notes_order').set(orderData);
            localStorage.setItem('zen_order_timestamp', timestamp);
        }

        // ==================== Funciones de carpeta_segura ====================
        async function uploadToSecureFolder() {
            if (!navigator.onLine) {
                alert('Sin conexión a internet.');
                return;
            }

            showLoading('Subiendo backup a carpeta_segura...');

            try {
                const backupData = {
                    notes: notes,
                    classes: classes,
                    deletedNotesLog: deletedNotesLog,
                    recentColors: recentColors,
                    masterClasses: masterClasses,
                    timestamp: Date.now(),
                    version: '1.1'
                };

                await db.ref('carpeta_segura/backup').set(backupData);
                await db.ref('carpeta_segura/metadata').set({
                    lastBackup: Date.now(),
                    noteCount: notes.length,
                    classCount: classes.length,
                    masterCount: masterClasses.length
                });

                alert('✅ Backup guardado exitosamente en carpeta_segura');
            } catch (error) {
                console.error('Error al subir backup:', error);
                alert('❌ Error al subir backup: ' + error.message);
            } finally {
                hideLoading();
            }
        }

        function showLoadConfirm() {
            if (!navigator.onLine) {
                alert('Sin conexión a internet.');
                return;
            }
            toggleModal('modal-load-confirm', true);
        }

        async function loadFromSecureFolder() {
            toggleModal('modal-load-confirm', false);
            showLoading('Cargando backup desde carpeta_segura...');

            try {
                const snapshot = await db.ref('carpeta_segura/backup').once('value');
                const backupData = snapshot.val();

                if (!backupData) {
                    alert('No se encontró ningún backup en carpeta_segura. Sube uno primero.');
                    hideLoading();
                    return;
                }

                // Reemplazar todos los datos locales
                notes = backupData.notes || [];
                classes = backupData.classes || ['tareas', 'comidas', 'links'];
                deletedNotesLog = backupData.deletedNotesLog || [];
                recentColors = backupData.recentColors || ['#4a9eff', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6'];
                masterClasses = backupData.masterClasses || [];

                // Asegurar que currentClass exista en las nuevas clases
                if (!classes.includes(currentClass)) {
                    currentClass = classes[0];
                }

                // Guardar en IndexedDB
                await saveToLocal();

                // Renderizar UI
                renderClasses();
                renderMasterClassesList();
                renderNotes();
                applySettings();

                alert(`✅ Backup cargado exitosamente.\nNotas: ${notes.length}\nClases: ${classes.length}`);
            } catch (error) {
                console.error('Error al cargar backup:', error);
                alert('❌ Error al cargar backup: ' + error.message);
            } finally {
                hideLoading();
            }
        }

        // ==================== Sincronización Unificada ====================
        async function fetchSyncData() {
            const snapshot = await db.ref('notes').once('value');
            const cloudNotes = snapshot.val() || {};
            const classesSnapshot = await db.ref('metadata/classes').once('value');
            const cloudClasses = classesSnapshot.val();
            const orderSnapshot = await db.ref('metadata/notes_order').once('value');
            const cloudOrder = orderSnapshot.val();
            const deletedSnapshot = await db.ref('metadata/deleted_notes').once('value');
            const cloudDeleted = deletedSnapshot.val();
            const masterSnapshot = await db.ref('metadata/master_classes').once('value');
            const cloudMaster = masterSnapshot.val();

            // 1. Notas eliminadas
            const deletedNotes = [];
            if (cloudDeleted && cloudDeleted.list) {
                for (const id of cloudDeleted.list) {
                    if (notes.find(n => n.id === id)) {
                        const note = notes.find(n => n.id === id);
                        deletedNotes.push({
                            id,
                            title: note?.title || id,
                            recommended: 'delete'
                        });
                    }
                }
            }

            // 2. Clases
            let classChanges = null;
            if (cloudClasses && cloudClasses.list) {
                const cloudClassesList = cloudClasses.list;
                if (JSON.stringify(classes) !== JSON.stringify(cloudClassesList)) {
                    const isCloudNewer = cloudClasses.timestamp > (parseInt(localStorage.getItem('zen_classes_timestamp')) || 0);
                    classChanges = {
                        cloud: cloudClassesList,
                        local: [...classes],
                        recommended: isCloudNewer ? 'cloud' : 'local'
                    };
                }
            }

            // 3. Colores
            const colorChanges = [];
            for (const note of notes) {
                const cloudNote = cloudNotes[note.id];
                if (cloudNote && cloudNote.color !== note.color) {
                    colorChanges.push({
                        id: note.id,
                        title: note.title,
                        localColor: note.color || 'predeterminado',
                        cloudColor: cloudNote.color || 'predeterminado',
                        recommended: (cloudNote.timestamp || 0) > note.timestamp ? 'cloud' : 'local'
                    });
                }
            }

            // 4. Conflictos de contenido
            const contentConflicts = [];
            for (const id in cloudNotes) {
                const cloudNote = cloudNotes[id];
                const localIdx = notes.findIndex(n => n.id === id);
                if (localIdx !== -1 && cloudNote.timestamp !== notes[localIdx].timestamp) {
                    const localNote = notes[localIdx];
                    contentConflicts.push({
                        id: id,
                        title: localNote.title,
                        localContent: localNote.content,
                        cloudContent: cloudNote.content,
                        localDate: localNote.date,
                        cloudDate: cloudNote.date,
                        recommended: cloudNote.timestamp > localNote.timestamp ? 'cloud' : 'local'
                    });
                }
            }

            // 5. Clases Maestras (Comparación inteligente)
            let masterChanges = null;
            if (cloudMaster && cloudMaster.list) {
                const isSame = areMasterClassesEqual(masterClasses, cloudMaster.list);
                if (!isSame) {
                    const isCloudNewer = cloudMaster.timestamp > (parseInt(localStorage.getItem('zen_master_timestamp')) || 0);
                    masterChanges = {
                        cloud: cloudMaster.list,
                        local: [...masterClasses],
                        recommended: isCloudNewer ? 'cloud' : 'local'
                    };
                }
            }

            // 6. Nuevas Notas (Cosas que están en la nube pero no aquí, y viceversa)
            const missingLocally = [];
            const missingInCloud = [];
            for (const id in cloudNotes) {
                if (!notes.find(n => n.id === id) && !deletedNotesLog.includes(id)) {
                    missingLocally.push(cloudNotes[id]);
                }
            }
            for (const note of notes) {
                if (!cloudNotes[note.id]) {
                    missingInCloud.push(note);
                }
            }

            // 7. Orden de las notas (Comparación por timestamp)
            let orderConflict = null;
            if (cloudOrder && cloudOrder._lastChanged) {
                const cloudOrderTime = cloudOrder._lastChanged;
                const localOrderTime = parseInt(localStorage.getItem('zen_order_timestamp')) || 0;
                
                // Solo verificar orden si hay notas comunes
                const commonNotes = notes.filter(n => cloudOrder[n.id]);
                const isOrderSame = commonNotes.every((n, i) => {
                    const cloudPos = cloudOrder[n.id];
                    // Buscamos la posición relativa en la nube para las notas comunes
                    const commonCloudOrder = commonNotes
                        .map(cn => ({ id: cn.id, cloudIdx: cloudOrder[cn.id].order }))
                        .sort((a, b) => a.cloudIdx - b.cloudIdx);
                    
                    return commonCloudOrder[i]?.id === n.id;
                });
                
                if (!isOrderSame || (Math.abs(cloudOrderTime - localOrderTime) > 1000)) {
                    orderConflict = {
                        cloudTime: cloudOrderTime,
                        localTime: localOrderTime,
                        recommended: cloudOrderTime > localOrderTime ? 'cloud' : 'local'
                    };
                }
            }
            
            return { deletedNotes, classChanges, colorChanges, contentConflicts, masterChanges, cloudOrder, orderConflict, missingLocally, missingInCloud };
        }

        // Función para comparar carpetas sin importar si Firebase borró los arrays vacíos
        function areMasterClassesEqual(list1, list2) {
            if (list1.length !== list2.length) return false;
            for (const m1 of list1) {
                const m2 = list2.find(m => m.name === m1.name);
                if (!m2) return false;
                const subs1 = (m1.subClasses || []).sort().join(',');
                const subs2 = (m2.subClasses || []).sort().join(',');
                if (subs1 !== subs2) return false;
            }
            return true;
        }

        function renderUnifiedModal(data) {
            const container = document.getElementById('sync-sections-container');
            container.innerHTML = '';

            // Sección de notas eliminadas
            if (data.deletedNotes.length > 0) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                section.innerHTML = `
                    <h4>🗑️ Eliminación de notas</h4>
                    <div id="deleted-notes-list"></div>
                `;
                const listDiv = section.querySelector('#deleted-notes-list');
                data.deletedNotes.forEach(note => {
                    const item = document.createElement('div');
                    item.className = 'sync-item';
                    item.innerHTML = `
                        <div><strong>${escapeHtml(note.title)}</strong></div>
                        <div class="sync-option-group">
                            <label class="sync-option ${note.recommended === 'delete' ? 'recommended' : ''}">
                                <input type="radio" name="del_${note.id}" value="delete" ${note.recommended === 'delete' ? 'checked' : ''}> 🗑️ Eliminar
                            </label>
                            <label class="sync-option ${note.recommended === 'keep' ? 'recommended' : ''}">
                                <input type="radio" name="del_${note.id}" value="keep" ${note.recommended === 'keep' ? 'checked' : ''}> 💾 Conservar
                            </label>
                        </div>
                    `;
                    listDiv.appendChild(item);
                });
                container.appendChild(section);
            }

            // Sección de clases
            if (data.classChanges) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                section.innerHTML = `
                    <h4>📁 Clases</h4>
                    <div class="sync-item">
                        <div><span class="badge badge-cloud">☁️ Nube</span> ${escapeHtml(data.classChanges.cloud.join(', '))}</div>
                        <div><span class="badge badge-local">💾 Local</span> ${escapeHtml(data.classChanges.local.join(', '))}</div>
                        <div class="sync-option-group" style="margin-top: 10px;">
                            <label class="sync-option ${data.classChanges.recommended === 'cloud' ? 'recommended' : ''}">
                                <input type="radio" name="class_choice" value="cloud" ${data.classChanges.recommended === 'cloud' ? 'checked' : ''}> ☁️ Usar nube
                            </label>
                            <label class="sync-option ${data.classChanges.recommended === 'local' ? 'recommended' : ''}">
                                <input type="radio" name="class_choice" value="local" ${data.classChanges.recommended === 'local' ? 'checked' : ''}> 💾 Mantener local
                            </label>
                        </div>
                    </div>
                `;
                container.appendChild(section);
            }

            // Sección de colores
            if (data.colorChanges.length > 0) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                section.innerHTML = `<h4>🎨 Colores</h4><div id="colors-list"></div>`;
                const listDiv = section.querySelector('#colors-list');
                data.colorChanges.forEach(color => {
                    const item = document.createElement('div');
                    item.className = 'sync-item';
                    item.innerHTML = `
                        <div><strong>${escapeHtml(color.title)}</strong></div>
                        <div>
                            <span class="badge badge-cloud">☁️ Nube</span>
                            <span class="color-preview-small" style="background-color: ${color.cloudColor !== 'predeterminado' ? color.cloudColor : '#242424'}"></span>
                            ${color.cloudColor}
                        </div>
                        <div>
                            <span class="badge badge-local">💾 Local</span>
                            <span class="color-preview-small" style="background-color: ${color.localColor !== 'predeterminado' ? color.localColor : '#242424'}"></span>
                            ${color.localColor}
                        </div>
                        <div class="sync-option-group">
                            <label class="sync-option ${color.recommended === 'cloud' ? 'recommended' : ''}">
                                <input type="radio" name="color_${color.id}" value="cloud" ${color.recommended === 'cloud' ? 'checked' : ''}> ☁️ Usar nube
                            </label>
                            <label class="sync-option ${color.recommended === 'local' ? 'recommended' : ''}">
                                <input type="radio" name="color_${color.id}" value="local" ${color.recommended === 'local' ? 'checked' : ''}> 💾 Mantener local
                            </label>
                        </div>
                    `;
                    listDiv.appendChild(item);
                });
                container.appendChild(section);
            }

            // Sección de conflictos de texto
            if (data.contentConflicts.length > 0) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                section.innerHTML = `<h4>📝 Texto</h4><div id="content-list"></div>`;
                const listDiv = section.querySelector('#content-list');
                data.contentConflicts.forEach(conflict => {
                    const item = document.createElement('div');
                    item.className = 'sync-item';
                    item.innerHTML = `
                        <div><strong>${escapeHtml(conflict.title)}</strong></div>
                        <div>
                            <span class="badge badge-cloud">☁️ Nube</span>
                            <div class="preview-text">${escapeHtml(truncateText(conflict.cloudContent, 80))}</div>
                            <small>${escapeHtml(conflict.cloudDate)}</small>
                        </div>
                        <div>
                            <span class="badge badge-local">💾 Local</span>
                            <div class="preview-text">${escapeHtml(truncateText(conflict.localContent, 80))}</div>
                            <small>${escapeHtml(conflict.localDate)}</small>
                        </div>
                        <div class="sync-option-group">
                            <label class="sync-option ${conflict.recommended === 'cloud' ? 'recommended' : ''}">
                                <input type="radio" name="content_${conflict.id}" value="cloud" ${conflict.recommended === 'cloud' ? 'checked' : ''}> ☁️ Usar nube
                            </label>
                            <label class="sync-option ${conflict.recommended === 'local' ? 'recommended' : ''}">
                                <input type="radio" name="content_${conflict.id}" value="local" ${conflict.recommended === 'local' ? 'checked' : ''}> 💾 Mantener local
                            </label>
                        </div>
                    `;
                    listDiv.appendChild(item);
                });
                container.appendChild(section);
            }

            // Sección de clases maestras
            if (data.masterChanges) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                section.innerHTML = `
                    <h4>🌈 Clases Maestras</h4>
                    <div class="sync-item">
                        <div><span class="badge badge-cloud">☁️ Nube</span> ${escapeHtml(data.masterChanges.cloud.map(m => m.name).join(', '))}</div>
                        <div><span class="badge badge-local">💾 Local</span> ${escapeHtml(data.masterChanges.local.map(m => m.name).join(', '))}</div>
                        <div class="sync-option-group" style="margin-top: 10px;">
                            <label class="sync-option ${data.masterChanges.recommended === 'cloud' ? 'recommended' : ''}">
                                <input type="radio" name="master_choice" value="cloud" ${data.masterChanges.recommended === 'cloud' ? 'checked' : ''}> ☁️ Usar nube
                            </label>
                            <label class="sync-option ${data.masterChanges.recommended === 'local' ? 'recommended' : ''}">
                                <input type="radio" name="master_choice" value="local" ${data.masterChanges.recommended === 'local' ? 'checked' : ''}> 💾 Mantener local
                            </label>
                        </div>
                    </div>
                `;
                container.appendChild(section);
            }

            // Sección de Orden de Notas
            if (data.orderConflict) {
                const section = document.createElement('div');
                section.className = 'sync-section';
                const cloudDate = new Date(data.orderConflict.cloudTime).toLocaleString();
                const localDate = new Date(data.orderConflict.localTime).toLocaleString();
                
                section.innerHTML = `
                    <h4>↕️ Orden de las Notas</h4>
                    <div class="sync-item">
                        <p style="font-size: 0.85rem; margin-bottom: 10px;">Se detectaron cambios en la organización.</p>
                        <div><span class="badge badge-cloud">☁️ Nube</span> Modificado: ${cloudDate}</div>
                        <div><span class="badge badge-local">💾 Local</span> Modificado: ${localDate}</div>
                        <div class="sync-option-group" style="margin-top: 10px;">
                            <label class="sync-option ${data.orderConflict.recommended === 'local' ? 'recommended' : ''}">
                                <input type="radio" name="order_choice" value="local" ${data.orderConflict.recommended === 'local' ? 'checked' : ''}> 💾 Usar orden local
                            </label>
                            <label class="sync-option ${data.orderConflict.recommended === 'cloud' ? 'recommended' : ''}">
                                <input type="radio" name="order_choice" value="cloud" ${data.orderConflict.recommended === 'cloud' ? 'checked' : ''}> ☁️ Usar orden nube
                            </label>
                        </div>
                    </div>
                `;
                container.appendChild(section);
            }

            // Botón marcar todo recomendado
            document.getElementById('mark-all-recommended').onclick = () => {
                document.querySelectorAll('#sync-sections-container input[type="radio"]').forEach(radio => {
                    const parent = radio.closest('.sync-option');
                    if (parent && parent.classList.contains('recommended')) {
                        radio.checked = true;
                    }
                });
            };

            // Botón marcar todo local (SUBIR)
            document.getElementById('mark-all-local').onclick = () => {
                document.querySelectorAll('#sync-sections-container input[type="radio"]').forEach(radio => {
                    if (radio.value === 'local' || radio.value === 'keep') {
                        radio.checked = true;
                    }
                });
            };
        }

        async function processSyncDecisions(conflictData) {
            // Procesar eliminaciones
            for (const note of conflictData.deletedNotes) {
                const choice = document.querySelector(`input[name="del_${note.id}"]:checked`)?.value;
                if (choice === 'delete') {
                    const index = notes.findIndex(n => n.id === note.id);
                    if (index !== -1) {
                        addToDeletedLog(note.id);
                        await db.ref('notes/' + note.id).remove();
                        notes.splice(index, 1);
                    }
                }
            }

            // Procesar clases
            const classChoice = document.querySelector('input[name="class_choice"]:checked')?.value;
            if (classChoice === 'cloud' && conflictData.classChanges) {
                classes = [...conflictData.classChanges.cloud];
                if (!classes.includes(currentClass)) currentClass = classes[0];
                saveClasses();
                await db.ref('metadata/classes').set({ list: classes, timestamp: Date.now() });
            } else if (classChoice === 'local' && conflictData.classChanges) {
                await db.ref('metadata/classes').set({ list: classes, timestamp: Date.now() });
            }

            // Procesar clases maestras
            const masterChoice = document.querySelector('input[name="master_choice"]:checked')?.value;
            if (masterChoice === 'cloud' && conflictData.masterChanges) {
                masterClasses = [...conflictData.masterChanges.cloud];
                saveMasterClasses();
            } else if (masterChoice === 'local' && conflictData.masterChanges) {
                saveMasterClasses();
            }

            // Procesar colores
            for (const color of conflictData.colorChanges) {
                const choice = document.querySelector(`input[name="color_${color.id}"]:checked`)?.value;
                const noteIndex = notes.findIndex(n => n.id === color.id);
                if (noteIndex !== -1) {
                    if (choice === 'cloud') {
                        notes[noteIndex].color = color.cloudColor !== 'predeterminado' ? color.cloudColor : undefined;
                    } else {
                        notes[noteIndex].color = color.localColor !== 'predeterminado' ? color.localColor : undefined;
                    }
                    if (notes[noteIndex].color === undefined) delete notes[noteIndex].color;
                    await db.ref('notes/' + color.id).update({ color: notes[noteIndex].color || null });
                }
            }

            // Procesar conflictos de contenido
            for (const conflict of conflictData.contentConflicts) {
                const choice = document.querySelector(`input[name="content_${conflict.id}"]:checked`)?.value;
                const noteIndex = notes.findIndex(n => n.id === conflict.id);
                if (noteIndex !== -1) {
                    if (choice === 'cloud') {
                        const cloudNote = (await db.ref('notes/' + conflict.id).once('value')).val();
                        if (cloudNote) notes[noteIndex] = cloudNote;
                    }
                    notes[noteIndex].synced = true;
                    await db.ref('notes/' + conflict.id).set(notes[noteIndex]);
                }
            }

            // 1. PROCESAR NOTAS NUEVAS (Merge automático)
            // Notas que están en la nube pero no aquí
            for (const newNote of conflictData.missingLocally) {
                notes.push(newNote);
            }
            // Notas locales que no están en la nube (Subirlas)
            for (const localNote of conflictData.missingInCloud) {
                localNote.synced = true;
                await db.ref('notes/' + localNote.id).set(localNote);
            }

            // 2. APLICAR ORDEN FINAL
            const orderChoice = document.querySelector('input[name="order_choice"]:checked')?.value;
            if (orderChoice === 'cloud' && conflictData.cloudOrder) {
                notes.sort((a, b) => {
                    const orderA = conflictData.cloudOrder[a.id] ? conflictData.cloudOrder[a.id].order : 999999;
                    const orderB = conflictData.cloudOrder[b.id] ? conflictData.cloudOrder[b.id].order : 999999;
                    if (orderA !== orderB) return orderA - orderB;
                    return (b.timestamp || 0) - (a.timestamp || 0);
                });
                localStorage.setItem('zen_order_timestamp', conflictData.cloudOrder._lastChanged);
            } else {
                // Si mantenemos local o no hay conflicto, subimos nuestro orden actual para unificar
                await uploadNotesOrderToCloud();
            }
            
            saveToLocal();
            renderNotes();
            renderClasses();
        }

        async function tryConnect() {
            if (!navigator.onLine) {
                alert("Sin conexión.");
                return;
            }

            const btn = document.getElementById('btn-connect');
            btn.innerText = "Detectando cambios...";
            btn.className = "syncing";

            isOnline = true;

            try {
                // Obtener datos de sincronización
                const syncDataResult = await fetchSyncData();

                // Si hay cambios, mostrar modal unificado
                if (syncDataResult.deletedNotes.length > 0 ||
                    syncDataResult.classChanges ||
                    syncDataResult.colorChanges.length > 0 ||
                    syncDataResult.contentConflicts.length > 0 ||
                    syncDataResult.masterChanges ||
                    syncDataResult.orderConflict) {

                    renderUnifiedModal(syncDataResult);
                    toggleModal('modal-unified-sync', true);

                    // Configurar botones
                    document.getElementById('process-all-btn').onclick = async () => {
                        await processSyncDecisions(syncDataResult);
                        toggleModal('modal-unified-sync', false);
                        btn.innerText = "En Línea";
                        btn.className = "online";
                    };

                    document.getElementById('cancel-sync-btn').onclick = () => {
                        toggleModal('modal-unified-sync', false);
                        btn.innerText = "Conectar";
                        btn.className = "offline";
                        isOnline = false;
                    };
                } else {
                    // No hay cambios, conectar directamente
                    await syncProcess();
                    btn.innerText = "En Línea";
                    btn.className = "online";
                }
            } catch (error) {
                console.error('Error en conexión:', error);
                alert('Error al conectar: ' + error.message);
                btn.innerText = "Conectar";
                btn.className = "offline";
                isOnline = false;
            }
        }

        async function syncProcess() {
            if (!isOnline) return;
            const snapshot = await db.ref('notes').once('value');
            const cloudNotes = snapshot.val() || {};

            // Descargar el orden de la nube
            const orderSnapshot = await db.ref('metadata/notes_order').once('value');
            const cloudOrder = orderSnapshot.val();

            for (const id in cloudNotes) {
                const cloudNote = cloudNotes[id];
                const localIdx = notes.findIndex(n => n.id === id);
                if (localIdx === -1) {
                    notes.push(cloudNote);
                }
            }

            // Aplicar el orden descargado antes de finalizar
            if (cloudOrder) {
                notes.sort((a, b) => {
                    const orderA = cloudOrder[a.id] ? cloudOrder[a.id].order : 999999;
                    const orderB = cloudOrder[b.id] ? cloudOrder[b.id].order : 999999;
                    if (orderA !== orderB) return orderA - orderB;
                    return (b.timestamp || 0) - (a.timestamp || 0);
                });
            }

            await finishSync();
        }

        async function finishSync() {
            for (let i = 0; i < notes.length; i++) {
                if (!notes[i].synced) {
                    notes[i].synced = true;
                    await db.ref('notes/' + notes[i].id).set(notes[i]);
                }
            }
            await uploadNotesOrderToCloud();
            await db.ref('metadata/master_classes').set({ list: masterClasses, timestamp: Date.now() });
            saveAndRender();
        }

        function saveNote() {
            const now = new Date();
            const id = currentNoteIndex !== null ? notes[currentNoteIndex].id : "ID_" + Date.now();
            const noteClass = currentNoteIndex !== null ? (notes[currentNoteIndex].clase || currentClass) : currentClass;
            const noteData = {
                id, clase: noteClass,
                title: document.getElementById('edit-title').value || 'Sin título',
                content: document.getElementById('edit-content').value,
                summary: document.getElementById('edit-summary').value,
                date: now.toLocaleString(), timestamp: now.getTime(), synced: false
            };
            if (currentNoteIndex !== null && notes[currentNoteIndex].color) noteData.color = notes[currentNoteIndex].color;
            if (currentNoteIndex === null) notes.unshift(noteData);
            else notes[currentNoteIndex] = noteData;
            saveToLocal();
            if (isOnline) finishSync();
            showLobby();
        }

        async function deleteNote(index) {
            if (!isOnline) return;
            const noteId = notes[index].id;
            if (confirm("¿Borrar de la nube?")) {
                addToDeletedLog(noteId);
                await db.ref('notes/' + noteId).remove();
                notes.splice(index, 1);
                await uploadNotesOrderToCloud();
                saveAndRender();
            }
        }

        async function saveToLocal() {
            try {
                if (typeof localDB === 'undefined') return;

                // Asegurar que cada nota guarde su posición actual
                notes.forEach((n, i) => n.order = i);

                await localDB.notes.clear();
                await localDB.notes.bulkAdd(notes);

                await localDB.appState.put({ id: 'deleted_log', data: deletedNotesLog });
                await localDB.appState.put({ id: 'classes', data: classes });
                await localDB.appState.put({ id: 'master_classes', data: masterClasses });
                await localDB.appState.put({ id: 'recent_colors', data: recentColors });

                localStorage.setItem('zen_current_class', currentClass);
                localStorage.setItem('zen_copy_mode', copyWithTitle);
                localStorage.setItem('zen_show_preview', showPreview);
                localStorage.setItem('zen_show_date', showDate);
                localStorage.setItem('zen_show_class', showClassTag);
                localStorage.setItem('zen_show_charcount', showCharCount);
                localStorage.setItem('zen_note_size', noteSize);
            } catch (e) {
                console.error("Error guardando en IndexedDB:", e);
            }
        }

        async function saveAndRender() { await saveToLocal(); renderNotes(); }
        function toggleModal(id, s) {
            const modal = document.getElementById(id);
            if (modal) modal.style.display = s ? 'block' : 'none';
        }
        function showView(id) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            if (id !== 'view-lobby') window.scrollTo(0, 0);
        }
        function showLobby() {
            renderNotes();
            showView('view-lobby');
            window.scrollTo(0, lobbyScrollPos);
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/[&<>]/g, function (m) {
                if (m === '&') return '&amp;';
                if (m === '<') return '&lt;';
                if (m === '>') return '&gt;';
                return m;
            });
        }

        function renderNotes() {
            const list = document.getElementById('notes-list');
            if (!list) return;
            list.innerHTML = '';
            let filteredNotes = notes.filter(n => n.clase === currentClass || (!n.clase && currentClass === classes[0]));
            filteredNotes.forEach((n) => {
                const originalIndex = notes.findIndex(note => note.id === n.id);
                const bgColor = n.color || '#242424';
                const textColor = getContrastColor(bgColor);
                const div = document.createElement('div');
                div.className = 'note-card';
                div.setAttribute('data-note-id', n.id);
                div.setAttribute('draggable', 'true');
                div.style.backgroundColor = bgColor;
                div.style.color = textColor;
                div.addEventListener('dragstart', (e) => noteDragStart(e, n.id));
                let previewHtml = '';
                if (showPreview && n.content) {
                    const truncatedContent = truncateText(n.content, 80);
                    previewHtml = `<div class="note-preview">${escapeHtml(truncatedContent)}</div>`;
                }
                let dateHtml = '';
                if (showDate && n.date) {
                    dateHtml = `<div class="note-date">📅 ${escapeHtml(n.date)}</div>`;
                }
                let classTagHtml = '';
                if (showClassTag) {
                    classTagHtml = `<span class="note-class-tag">${escapeHtml(n.clase || 'tareas')}</span>`;
                }
                let charCountHtml = '';
                if (showCharCount) {
                    const count = (n.content || '').length;
                    charCountHtml = `<span class="note-char-count-tag">${count} caracteres</span>`;
                }

                div.innerHTML = `
                    <div class="card-header">
                        <div class="card-content" onclick="openNote('${n.id}')">
                            <h3>${escapeHtml(n.title)} ${n.synced ? '' : '<span class="sync-warn">⚠️ Local</span>'}</h3>
                            ${dateHtml}
                            ${previewHtml}
                            ${classTagHtml}
                            ${charCountHtml}
                        </div>
                        <div style="display: flex; gap: 5px;">
                            <div class="drag-note-handle" title="Arrastrar para reordenar">⋮⋮</div>
                            <button class="color-btn" onclick="event.stopPropagation(); openColorModal('${n.id}')" style="color: ${textColor};">🎨</button>
                        </div>
                    </div>
                    <div class="card-actions" onclick="event.stopPropagation()">
                        <div class="action-buttons">
                            <button class="btn-sm" onclick="copyNote('${n.id}')">Copiar</button>
                            <button class="btn-sm" ${!isOnline ? 'disabled' : ''} onclick="deleteNote(${originalIndex})">Borrar</button>
                        </div>
                    </div>
                `;
                const btns = div.querySelectorAll('.btn-sm, .color-btn, .drag-note-handle');
                btns.forEach(btn => { btn.style.color = textColor; btn.style.borderColor = textColor + '40'; });
                const tag = div.querySelector('.note-class-tag');
                if (tag) {
                    tag.style.backgroundColor = textColor === '#000000' ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)';
                    tag.style.color = textColor;
                }
                const charTag = div.querySelector('.note-char-count-tag');
                if (charTag) {
                    charTag.style.backgroundColor = textColor === '#000000' ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)';
                    charTag.style.color = textColor;
                    charTag.style.borderColor = textColor + '40';
                }
                list.appendChild(div);
            });
        }

        function copyNote(id) {
            const note = notes.find(n => n.id === id);
            if (note) {
                const textToCopy = copyWithTitle ? note.title + "\n\n" + note.content : note.content;
                navigator.clipboard.writeText(textToCopy);
                alert(copyWithTitle ? "Copiado con título." : "Copiado sin título.");
            }
        }

        function updateEditCharCount() {
            const content = document.getElementById('edit-content').value || '';
            document.getElementById('edit-char-count').innerText = `${content.length} caracteres`;
        }

        function createNewNote() {
            currentNoteIndex = null;
            document.getElementById('edit-title').value = '';
            document.getElementById('edit-content').value = '';
            document.getElementById('edit-summary').value = '';
            updateEditCharCount();
            showView('view-edit');
        }

        function openNote(id) {
            lobbyScrollPos = window.scrollY;
            currentNoteIndex = notes.findIndex(n => n.id === id);
            const n = notes[currentNoteIndex];
            document.getElementById('read-title').innerText = n.title;
            document.getElementById('read-summary').innerText = n.summary || "Sin resumen";
            document.getElementById('read-content').innerText = n.content;
            const contentLen = (n.content || '').length;
            document.getElementById('read-char-count').innerText = `${contentLen} caracteres`;
            showView('view-read');
        }

        function editCurrentNote() {
            const n = notes[currentNoteIndex];
            document.getElementById('edit-title').value = n.title;
            document.getElementById('edit-content').value = n.content;
            document.getElementById('edit-summary').value = n.summary;
            updateEditCharCount();
            showView('view-edit');
        }

        function cancelEdit() {
            if (currentNoteIndex === null) {
                showLobby();
            } else {
                // Volver a la vista de lectura de la nota actual
                const n = notes[currentNoteIndex];
                document.getElementById('read-title').innerText = n.title;
                document.getElementById('read-summary').innerText = n.summary || "Sin resumen";
                document.getElementById('read-content').innerText = n.content;
                const contentLen = (n.content || '').length;
                document.getElementById('read-char-count').innerText = `${contentLen} caracteres`;
                showView('view-read');
            }
        }

        async function saveClasses() {
            await saveToLocal();
            renderClasses();
            renderClassesList();
            renderClassSelector();
        }

        async function uploadClassesToCloud() {
            if (!isOnline) return;
            await db.ref('metadata/classes').set({ list: classes, timestamp: Date.now() });
        }

        function renderClasses() {
            const bar = document.getElementById('classes-bar');
            if (!bar) return;
            let html = '';

            if (currentMasterClass) {
                // Vista dentro de una Clase Maestra
                const master = masterClasses.find(m => m.name === currentMasterClass);
                html += `<button class="class-btn master-back-btn" onclick="toggleMasterView(null)">📂 ${escapeHtml(currentMasterClass)}</button>`;
                if (master) {
                    const subList = master.subClasses || [];
                    subList.forEach(cls => {
                        html += `<button class="class-btn ${currentClass === cls ? 'active' : ''}" onclick="selectClass('${cls.replace(/'/g, "\\'")}')">${escapeHtml(cls)}</button>`;
                    });
                }
            } else {
                // Vista General
                // Primero las Clases Maestras
                masterClasses.forEach(master => {
                    html += `<button class="class-btn master" onclick="toggleMasterView('${master.name.replace(/'/g, "\\'")}')">${escapeHtml(master.name)}</button>`;
                });

                // Luego las clases que NO están en ninguna clase maestra
                classes.forEach(cls => {
                    const isInsideFolder = masterClasses.some(m => m.subClasses && m.subClasses.includes(cls));
                    if (!isInsideFolder) {
                        html += `<button class="class-btn ${currentClass === cls ? 'active' : ''}" onclick="selectClass('${cls.replace(/'/g, "\\'")}')">${escapeHtml(cls)}</button>`;
                    }
                });
            }

            html += `<button class="class-btn add" onclick="toggleModal('modal-class-manager', true)">✏️ Gestionar</button>`;
            bar.innerHTML = html;
        }

        function toggleMasterView(masterName) {
            if (currentMasterClass === masterName) {
                currentMasterClass = null;
            } else {
                currentMasterClass = masterName;
                // Al entrar en una carpeta, seleccionamos la primera sub-clase si existe
                if (masterName) {
                    const master = masterClasses.find(m => m.name === masterName);
                    if (master && master.subClasses && master.subClasses.length > 0) {
                        currentClass = master.subClasses[0];
                    }
                }
            }
            renderClasses();
            renderNotes();
        }

        async function saveMasterClasses() {
            // Normalizar: asegurar que todas las carpetas tengan el array subClasses
            masterClasses.forEach(m => {
                if (!m.subClasses) m.subClasses = [];
            });
            await saveToLocal();
            renderClasses();
            renderMasterClassesList();
            if (isOnline) {
                db.ref('metadata/master_classes').set({ list: masterClasses, timestamp: Date.now() });
            }
        }

        function addNewMasterClass() {
            const input = document.getElementById('new-master-name');
            const name = input.value.trim();
            if (name && !masterClasses.find(m => m.name === name)) {
                masterClasses.push({ name: name, subClasses: [] });
                saveMasterClasses();
                input.value = '';
            }
        }

        async function deleteMasterClass(name) {
            const master = masterClasses.find(m => m.name === name);
            if (!master) return;

            const subs = master.subClasses || [];
            const notesToDelete = notes.filter(n => subs.includes(n.clase));

            const msg = `🚨 PELIGRO: Estás a punto de eliminar la Clase Maestra "${name}".\n\n` +
                `Esta acción ELIMINARÁ permanentemente:\n` +
                `- La carpeta "${name}"\n` +
                `- Las clases: ${subs.join(', ') || 'ninguna'}\n` +
                `- ${notesToDelete.length} notas que están dentro de esas clases.\n\n` +
                `¿Estás SEGURO de querer continuar?`;

            if (confirm(msg)) {
                // 1. Registrar las notas borradas para sincronización
                notesToDelete.forEach(n => {
                    deletedNotesLog.push({ id: n.id, timestamp: Date.now() });
                });

                // 2. Filtrar notas y clases
                notes = notes.filter(n => !subs.includes(n.clase));
                classes = classes.filter(c => !subs.includes(c));

                // 3. Eliminar la Clase Maestra
                masterClasses = masterClasses.filter(m => m.name !== name);

                if (currentMasterClass === name) currentMasterClass = null;

                // 4. Guardar y actualizar todo
                saveMasterClasses(); // Actualiza carpetas
                saveClasses();       // Actualiza clases
                saveToLocal();       // Actualiza notas

                renderClasses();
                renderClassesList();
                renderNotes();

                if (isOnline) {
                    await uploadClassesToCloud();
                    await uploadNotesOrderToCloud();
                    // Sincronizar log de eliminaciones
                    db.ref('metadata/deleted_notes').set({ list: deletedNotesLog, timestamp: Date.now() });
                }

                alert(`✅ Se ha eliminado la carpeta "${name}" y todo su contenido.`);
            }
        }

        function toggleSubclassInMaster(masterName, subClassName) {
            const master = masterClasses.find(m => m.name === masterName);
            if (master) {
                if (!master.subClasses) master.subClasses = [];
                const index = master.subClasses.indexOf(subClassName);
                if (index === -1) {
                    master.subClasses.push(subClassName);
                } else {
                    master.subClasses.splice(index, 1);
                }
                saveMasterClasses();
                renderMasterSubclassSelection(masterName);
            }
        }

        function renderMasterSubclassSelection(masterName) {
            const container = document.getElementById('master-subclasses-selection');
            const master = masterClasses.find(m => m.name === masterName);
            document.getElementById('edit-master-title').innerText = `Contenido de: ${masterName}`;
            
            const subList = master.subClasses || [];
            
            if (subList.length === 0) {
                container.innerHTML = '<p style="color: var(--text-dim); text-align: center; padding: 20px;">Esta carpeta está vacía.<br>Envía clases aquí desde "Gestionar Clases".</p>';
                toggleModal('modal-master-edit', true);
                return;
            }

            container.innerHTML = '';
            subList.forEach((cls, index) => {
                const div = document.createElement('div');
                div.className = 'class-item';
                div.setAttribute('draggable', 'true');
                
                // Drag and drop dentro de la carpeta
                div.ondragstart = (e) => {
                    e.dataTransfer.setData('text/plain', index);
                    e.target.classList.add('dragging');
                };
                div.ondragover = (e) => {
                    e.preventDefault();
                    e.target.closest('.class-item')?.classList.add('drag-over');
                };
                div.ondragleave = (e) => e.target.closest('.class-item')?.classList.remove('drag-over');
                div.ondrop = (e) => {
                    e.preventDefault();
                    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                    if (fromIdx !== index) {
                        const [moved] = master.subClasses.splice(fromIdx, 1);
                        master.subClasses.splice(index, 0, moved);
                        saveMasterClasses();
                        renderMasterSubclassSelection(masterName);
                    }
                };
                div.ondragend = (e) => e.target.classList.remove('dragging');

                div.innerHTML = `
                    <div class="class-item-left">
                        <span class="drag-handle">⋮⋮</span>
                        <span class="class-name">${escapeHtml(cls)}</span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <button class="btn-sm" style="border-color: var(--warning); color: var(--warning);" onclick="removeClassFromMaster('${cls.replace(/'/g, "\\'")}', '${masterName.replace(/'/g, "\\'")}')">Sacar</button>
                        <button class="delete-class" onclick="deleteClass('${cls.replace(/'/g, "\\'")}')">Eliminar</button>
                    </div>
                `;
                container.appendChild(div);
            });
            toggleModal('modal-master-edit', true);
        }

        function removeClassFromMaster(cls, masterName) {
            if (confirm(`¿Deseas sacar la clase "${cls}" de la carpeta "${masterName}"?`)) {
                const master = masterClasses.find(m => m.name === masterName);
                if (master) {
                    master.subClasses = master.subClasses.filter(c => c !== cls);
                    saveMasterClasses();
                    renderMasterSubclassSelection(masterName);
                    renderClassesList();
                }
            }
        }

        function renderMasterClassesList() {
            const list = document.getElementById('master-classes-list');
            if (!list) return;
            list.innerHTML = '';
            masterClasses.forEach(master => {
                const div = document.createElement('div');
                div.className = 'class-item';
                const subCount = master.subClasses ? master.subClasses.length : 0;
                div.innerHTML = `
                    <span class="class-name">📂 ${escapeHtml(master.name)} (${subCount})</span>
                    <div style="display: flex; gap: 5px;">
                        <button class="btn-sm" style="border-color: var(--accent); color: var(--accent);" onclick="renderMasterSubclassSelection('${master.name.replace(/'/g, "\\'")}')">Editar</button>
                        <button class="delete-class" onclick="deleteMasterClass('${master.name.replace(/'/g, "\\'")}')">Eliminar</button>
                    </div>
                `;
                list.appendChild(div);
            });
        }

        function selectClass(cls, shouldScroll = false) {
            currentClass = cls;
            lobbyScrollPos = 0;
            saveClasses();
            renderNotes();

            // Auto-scroll de la barra de clases SOLO si se solicita (ej. en swipe)
            if (shouldScroll) {
                setTimeout(() => {
                    const bar = document.getElementById('classes-bar');
                    const activeBtn = bar?.querySelector('.class-btn.active');
                    if (activeBtn) {
                        activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                    }
                }, 50);
            }
        }

        async function addNewClass() {
            const input = document.getElementById('new-class-name');
            const newClass = input.value.trim().toLowerCase();
            if (newClass && !classes.includes(newClass)) {
                classes.push(newClass);
                saveClasses();
                renderClassesList();
                renderClasses();
                input.value = '';
                if (isOnline) await uploadClassesToCloud();
            } else if (classes.includes(newClass)) {
                alert('Esta clase ya existe');
            } else if (!newClass) {
                alert('Ingresa un nombre para la clase');
            }
        }

        async function deleteClass(cls) {
            if (classes.length <= 1) {
                alert('Debe haber al menos una clase');
                return;
            }
            const notesCount = notes.filter(n => n.clase === cls).length;
            if (confirm(`⚠️ ¿Eliminar la clase "${cls}"?\nSe perderán ${notesCount} notas de esta clase.`)) {
                notes = notes.filter(n => n.clase !== cls);
                classes = classes.filter(c => c !== cls);

                // Limpiar la clase de cualquier Clase Maestra que la contenga
                masterClasses.forEach(m => {
                    m.subClasses = m.subClasses.filter(sc => sc !== cls);
                });
                saveMasterClasses(); // Guarda y actualiza UI de carpetas

                if (currentClass === cls) currentClass = classes[0];
                saveClasses();
                saveToLocal();
                renderClassesList();
                renderNotes();
                renderClasses();
                if (isOnline) await uploadClassesToCloud();
            }
        }

        function classDragStart(e, index) {
            draggedClassItem = index;
            e.target.closest('.class-item')?.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
        }

        function classDragOver(e, index) {
            e.preventDefault();
            e.target.closest('.class-item')?.classList.add('drag-over');
        }

        function classDragLeave(e) {
            e.target.closest('.class-item')?.classList.remove('drag-over');
        }

        async function classDrop(e, targetIndex) {
            e.preventDefault();
            if (draggedClassItem !== null && draggedClassItem !== targetIndex) {
                const [removed] = classes.splice(draggedClassItem, 1);
                classes.splice(targetIndex, 0, removed);
                saveClasses();
                renderClassesList();
                renderClasses();
                if (isOnline) await uploadClassesToCloud();
            }
            document.querySelectorAll('.class-item').forEach(item => {
                item.classList.remove('drag-over', 'dragging');
            });
            draggedClassItem = null;
        }

        function classDragEnd(e) {
            document.querySelectorAll('.class-item').forEach(item => {
                item.classList.remove('drag-over', 'dragging');
            });
            draggedClassItem = null;
        }

        function renderClassesList() {
            const list = document.getElementById('classes-list');
            if (!list) return;
            list.innerHTML = '';
            
            // Solo mostrar clases que NO están en ninguna carpeta
            const independentClasses = classes.filter(cls => !masterClasses.some(m => m.subClasses && m.subClasses.includes(cls)));
            
            independentClasses.forEach((cls, index) => {
                const div = document.createElement('div');
                div.className = 'class-item';
                div.setAttribute('draggable', 'true');
                
                // Re-mapear el Drag and Drop para trabajar con la lista filtrada
                div.addEventListener('dragstart', (e) => {
                    draggedClassItem = classes.indexOf(cls);
                    e.target.closest('.class-item')?.classList.add('dragging');
                    e.dataTransfer.setData('text/plain', draggedClassItem);
                });
                div.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.target.closest('.class-item')?.classList.add('drag-over');
                });
                div.addEventListener('dragleave', (e) => e.target.closest('.class-item')?.classList.remove('drag-over'));
                div.addEventListener('drop', (e) => {
                    e.preventDefault();
                    const targetIndex = classes.indexOf(cls);
                    if (draggedClassItem !== null && draggedClassItem !== targetIndex) {
                        const [removed] = classes.splice(draggedClassItem, 1);
                        classes.splice(targetIndex, 0, removed);
                        saveClasses();
                        renderClassesList();
                        renderClasses();
                    }
                });

                div.innerHTML = `
                    <div class="class-item-left">
                        <span class="drag-handle">⋮⋮</span>
                        <span class="class-name">${escapeHtml(cls)}</span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <button class="btn-sm" style="border-color: var(--accent); color: var(--accent);" onclick="promptMoveToMaster('${cls.replace(/'/g, "\\'")}')">Enviar a...</button>
                        <button class="delete-class" onclick="deleteClass('${cls.replace(/'/g, "\\'")}')">Eliminar</button>
                    </div>
                `;
                list.appendChild(div);
            });
            
            if (independentClasses.length === 0) {
                list.innerHTML = '<p style="color: var(--text-dim); text-align: center; font-size: 0.8rem;">Todas las clases están organizadas en carpetas.</p>';
            }
        }

        function promptMoveToMaster(cls) {
            if (masterClasses.length === 0) {
                alert("Crea primero una Clase Maestra (Carpeta) para poder mover clases.");
                return;
            }
            const options = masterClasses.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
            const choice = prompt(`Enviar "${cls}" a:\n\n${options}\n\nIngresa el número de la carpeta:`);
            
            const idx = parseInt(choice) - 1;
            if (masterClasses[idx]) {
                const master = masterClasses[idx];
                if (!master.subClasses) master.subClasses = [];
                master.subClasses.push(cls);
                saveMasterClasses();
                renderClassesList();
                alert(`Clase "${cls}" movida a "${master.name}"`);
            }
        }

        function renderClassSelector() {
            const selector = document.getElementById('class-select-list');
            if (!selector) return;
            selector.innerHTML = '';
            classes.forEach(cls => {
                const div = document.createElement('div');
                div.className = 'class-item';
                div.style.cursor = 'pointer';
                div.style.marginBottom = '8px';
                div.onclick = () => {
                    if (currentNoteIndex !== null) {
                        notes[currentNoteIndex].clase = cls;
                        saveToLocal();
                        renderNotes();
                        if (isOnline) finishSync();
                    }
                    toggleModal('modal-class-select', false);
                };
                const isSelected = currentNoteIndex !== null && notes[currentNoteIndex]?.clase === cls;
                div.innerHTML = `<span>${escapeHtml(cls)}</span>${isSelected ? ' ✓' : ''}`;
                selector.appendChild(div);
            });

            if (classes.length === 0) {
                selector.innerHTML = '<p style="color: var(--text-dim);">No hay clases. Crea una en "Gestionar Clases"</p>';
            }
        }

        function applySettings() {
            const copyBtn = document.getElementById('btn-copy-mode');
            if (copyBtn) copyBtn.innerText = copyWithTitle ? '📋 +título' : '📋 -título';
            const previewBtn = document.getElementById('btn-preview-mode');
            if (previewBtn) previewBtn.innerText = showPreview ? '📄 +contenido' : '📄 -contenido';
            const dateBtn = document.getElementById('btn-date-mode');
            if (dateBtn) dateBtn.innerText = showDate ? '📅 +fecha' : '📅 -fecha';
            const classTagBtn = document.getElementById('btn-class-mode');
            if (classTagBtn) classTagBtn.innerText = showClassTag ? '🏷️ +clase' : '🏷️ -clase';
            const charCountBtn = document.getElementById('btn-charcount-mode');
            if (charCountBtn) charCountBtn.innerText = showCharCount ? '📊 -caracteres' : '📊 +caracteres';
            document.body.className = `size-${noteSize}`;
            ['large', 'medium', 'compact', 'ultra-compact'].forEach(size => {
                const el = document.getElementById(`size-${size}`);
                if (el) {
                    if (size === noteSize) el.classList.add('active');
                    else el.classList.remove('active');
                }
            });
        }

        function toggleCopyMode() {
            copyWithTitle = !copyWithTitle;
            localStorage.setItem('zen_copy_mode', copyWithTitle);
            applySettings();
        }

        function setNoteSize(size) {
            noteSize = size;
            localStorage.setItem('zen_note_size', size);
            applySettings();
            renderNotes();
            toggleModal('modal-size', false);
        }

        // --- GESTOS DE DESLIZAMIENTO (SWIPE) PARA CAMBIAR CLASES ---
        let touchStartX = 0;
        let touchStartY = 0;
        let touchEndX = 0;
        let touchEndY = 0;
        let isSwipeDisabled = false;

        function handleSwipe() {
            if (isSwipeDisabled) return;
            const dx = touchEndX - touchStartX;
            const dy = touchEndY - touchStartY;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);

            // Umbral: al menos 70px de desplazamiento horizontal
            // Y que el movimiento sea predominantemente horizontal (ratio 1.8:1)
            if (absDx > 70 && absDx > absDy * 1.8) {
                const activeClasses = getActiveClassesList();
                if (activeClasses.length <= 1) return;

                const currentIndex = activeClasses.indexOf(currentClass);
                let nextIndex = currentIndex;
                const notesList = document.getElementById('notes-list');

                if (dx > 0) {
                    // Swipe Derecha -> Anterior (Empujar hacia la derecha)
                    notesList.classList.add('swipe-exit-right');
                    setTimeout(() => {
                        nextIndex = (currentIndex - 1 + activeClasses.length) % activeClasses.length;
                        selectClass(activeClasses[nextIndex], true);
                        notesList.classList.remove('swipe-exit-right');
                        notesList.classList.add('swipe-enter-left');
                        setTimeout(() => notesList.classList.remove('swipe-enter-left'), 200);
                        if (window.navigator.vibrate) window.navigator.vibrate(10);
                    }, 150);
                } else {
                    // Swipe Izquierda -> Siguiente (Empujar hacia la izquierda)
                    notesList.classList.add('swipe-exit-left');
                    setTimeout(() => {
                        nextIndex = (currentIndex + 1) % activeClasses.length;
                        selectClass(activeClasses[nextIndex], true);
                        notesList.classList.remove('swipe-exit-left');
                        notesList.classList.add('swipe-enter-right');
                        setTimeout(() => notesList.classList.remove('swipe-enter-right'), 200);
                        if (window.navigator.vibrate) window.navigator.vibrate(10);
                    }, 150);
                }
            }
        }

        function getActiveClassesList() {
            if (currentMasterClass) {
                const master = masterClasses.find(m => m.name === currentMasterClass);
                return master ? (master.subClasses || []) : [];
            } else {
                // Clases que no están en ninguna carpeta
                return classes.filter(cls => !masterClasses.some(m => m.subClasses && m.subClasses.includes(cls)));
            }
        }

        // Inicialización
        async function initApp() {
            showLoading('Cargando datos...');
            try {
                // 1. Intentar cargar desde IndexedDB
                const savedNotes = await localDB.notes.toArray();
                const savedLog = await localDB.appState.get('deleted_log');
                const savedClasses = await localDB.appState.get('classes');
                const savedMaster = await localDB.appState.get('master_classes');
                const savedColors = await localDB.appState.get('recent_colors');

                if (savedNotes.length > 0) {
                    // Ordenar las notas recuperadas por su propiedad 'order'
                    notes = savedNotes.sort((a, b) => {
                        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
                        return (b.timestamp || 0) - (a.timestamp || 0); // Fallback: más nuevas primero
                    });
                    deletedNotesLog = savedLog ? savedLog.data : [];
                    classes = savedClasses ? savedClasses.data : ['tareas', 'comidas', 'links'];
                    masterClasses = savedMaster ? savedMaster.data : [];
                    recentColors = savedColors ? savedColors.data : recentColors;
                } else {
                    // 2. MIGRACIÓN: Si IndexedDB está vacío, buscar en localStorage
                    console.log("Migrando datos de localStorage a IndexedDB...");
                    const oldNotes = JSON.parse(localStorage.getItem('zen_v3')) || [];
                    if (oldNotes.length > 0) {
                        notes = oldNotes;
                        deletedNotesLog = JSON.parse(localStorage.getItem('zen_deleted_log')) || [];
                        classes = JSON.parse(localStorage.getItem('zen_classes')) || ['tareas', 'comidas', 'links'];

                        try {
                            const savedMasterLS = localStorage.getItem('zen_master_classes');
                            masterClasses = JSON.parse(savedMasterLS);
                            if (!Array.isArray(masterClasses)) masterClasses = [];
                        } catch (e) { masterClasses = []; }

                        recentColors = JSON.parse(localStorage.getItem('zen_recent_colors')) || recentColors;

                        // Guardar en el nuevo sistema
                        await saveToLocal();
                        console.log("Migración completada.");
                    }
                }
            } catch (e) {
                console.error("Error al inicializar base de datos:", e);
            }

            hideLoading();
            applySettings();
            renderClasses();
            renderClassesList();
            renderMasterClassesList();
            renderClassSelector();
            renderNotes();

            // Configurar Listeners para Swipe en el Lobby
            const lobby = document.getElementById('view-lobby');
            lobby.addEventListener('touchstart', (e) => {
                // Si el toque empieza en la barra de clases, desactivar swipe
                if (e.target.closest('#classes-bar')) {
                    isSwipeDisabled = true;
                } else {
                    isSwipeDisabled = false;
                }
                touchStartX = e.changedTouches[0].screenX;
                touchStartY = e.changedTouches[0].screenY;
            }, { passive: true });

            lobby.addEventListener('touchend', (e) => {
                touchEndX = e.changedTouches[0].screenX;
                touchEndY = e.changedTouches[0].screenY;
                handleSwipe();
            }, { passive: true });
        }

        initApp();