import React, { useState } from 'react';
import PropTypes from 'prop-types';

export function Gallery({ photos }) {
  const [selected, setSelected] = useState(null);
  return (
    <div className="gallery">
      {photos.length === 0 && <p>empty</p>}
      {photos.map((photo) => (
        <img
          key={photo.id}
          alt={photo.caption || 'untitled'}
          src={photo.url}
          onClick={() => setSelected(photo.id)}
        />
      ))}
      {selected != null ? <span>selected: {selected}</span> : null}
    </div>
  );
}

Gallery.propTypes = {
  photos: PropTypes.array.isRequired,
};

const Placeholder = () => <div className="placeholder" />;

export function renderFallback(kind) {
  if (kind === 'placeholder') {
    return React.createElement(Placeholder);
  }
  return React.createElement('div', null, 'fallback');
}

export default Gallery;
